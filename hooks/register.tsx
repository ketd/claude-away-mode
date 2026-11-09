import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AwayModeEvent, AwayModeEventKind, AwayModeFlag } from '../types'

type Engine = EngineInterface

// ── shared switch ────────────────────────────────────────────────────────────
// One file under $HOME, so every session (and every Claude account on this
// machine) reads the same switch. $.store is per-plugin JSON with no promise
// that a write in one session is seen by another, so it is not used for this.
const FLAG_FILE = '.claude/away-mode.json'
const POLL_MS = 3000
const MAX_NUDGES = 5
const MARKER = '⏸ 等你回来'

const OFF: AwayModeFlag = { isOn: false, since: 0 }
const flag = atom({ plugin: 'away-mode', key: 'flag' } as const, OFF)
// Change the tag when AwayModeEvent changes shape.
const log = atom({ plugin: 'away-mode', key: 'log' } as const, [], {
  shape: 'log-1',
})

// ── what the model reads ─────────────────────────────────────────────────────
const POLICY = `# 出门模式（已开启）

用户开启了出门模式，现在不在电脑前，没人会回答问题或做确认。本节优先于平时"先对齐再动手""拿不准就问"的习惯，直到它从系统提示中消失。

- 不调用 AskUserQuestion，不进入计划模式。遇到选择题，自己挑最佳方案（就是你本来会标 Recommended 的那个）直接执行。
- 不在回复末尾问"要我继续吗""选 A 还是 B"然后停下。能做的一口气做完。
- 自主做出的、用户可能有不同看法的决策，逐条记下：问题 → 选择 → 理由。最终汇报里放一节「出门期间的决策」。
- 安全边界不变。不可逆或对外的操作一律不执行：git push、创建或合并 PR、部署生产、删除数据或文件、给别人发消息/邮件/评论、付费、改动线上资源。把它之前的工作全部做完、准备好（命令写好、改动留在本地），列进「${MARKER}」清单，然后继续做不依赖它的部分。本模式不改任何权限规则。
- 确实卡在只有用户能提供的东西上（登录、验证码、密钥、上面那些不可逆操作），并且没有其他能推进的工作时：写一节以「${MARKER}」开头的清单，说清需要用户做什么，然后结束回合。
- 主任务完成就停。可选的后续写成建议列表，不提问，也不自行扩大范围。
- 如果有 PushNotification 工具：全部完成，或卡在「${MARKER}」时，发一条简短推送。`

const DENY_ASK = `[出门模式] 用户不在电脑前，这个问题没人会回答。不要再调用 AskUserQuestion：按你判断的最佳方案（你会标 Recommended 的那个）直接执行，并在最终汇报的「出门期间的决策」里记一行：问题 → 选择 → 理由。`

const DENY_PLAN = `[出门模式] 用户不在，没人批准计划，所以不进入计划模式。在心里定好计划后直接执行，关键取舍记进「出门期间的决策」。`

const NUDGE = `[出门模式] 用户不在电脑前，没人会回答或确认。按你推荐的方案自己决定，继续执行，并把这个决策记进「出门期间的决策」。
- 主任务其实已完成、你只是在提可选后续：把后续写成建议清单，直接结束，不扩大范围。
- 你只是在等后台任务或定时唤醒：直接结束即可。
- 确实卡在只有用户能做的事上，且没有别的能推进：写一节以「${MARKER}」开头的清单，再结束。`

const RESUME = `（出门模式自动发送）我出门了，不在电脑前。你上面问我的问题，请按你推荐的方案自己决定并继续执行，决策记进「出门期间的决策」。如果其实没有待决的问题，回一句"没有待决问题"即可。`

// ── is the model waiting on the person? ──────────────────────────────────────
const WAITING = 'waiting_for_user_answer'
const NOT_WAITING = 'not_waiting_for_user'
const ASKY =
  /(要我|需要我|是否|你想|你希望|你觉得|你倾向|请确认|确认一下|还是说|选哪|哪个方案|哪一个|可以吗|行吗|好吗|如何选择|怎么选|should i|do you want|would you like|which (one|option|approach)|let me know|shall i|prefer)/i

async function looksWaiting($: Engine, text: string): Promise<boolean> {
  const tail = text.trim().slice(-1500)
  if (tail === '' || tail.includes(MARKER)) return false
  try {
    const label = await $.model.classify(
      `An AI coding assistant ended its turn with the message below.\n` +
        `${WAITING}: it stops to ask the user a question, to choose between options, or to confirm/approve something before it continues the task.\n` +
        `${NOT_WAITING}: the task is finished (optional follow-up suggestions included), it is reporting results, or it waits on background work.\n` +
        `---\n${tail}`,
      [WAITING, NOT_WAITING],
    )
    if (label !== undefined) return label === WAITING
  } catch {
    // fall through to the heuristic
  }
  const end = tail.slice(-400)
  return /[?？]/.test(end) && ASKY.test(end)
}

// ── module state (a reload starts these over, which is harmless) ─────────────
let nudges = 0
let isTurnRunning = false
let syncing: Promise<AwayModeFlag> | undefined

// ── helpers ──────────────────────────────────────────────────────────────────
async function flagPath($: Engine): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  return `${home}/${FLAG_FILE}`
}

async function readFlag($: Engine): Promise<AwayModeFlag> {
  try {
    const raw = JSON.parse(await $.fs.read(await flagPath($))) as Partial<AwayModeFlag>
    return {
      isOn: raw.isOn === true,
      since: typeof raw.since === 'number' ? raw.since : 0,
    }
  } catch {
    return OFF
  }
}

/** Reads the shared file, mirrors it into $.state, and reacts to an off→on edge. */
function sync($: Engine): Promise<AwayModeFlag> {
  syncing ??= (async () => {
    try {
      const disk = await readFlag($)
      const held = await read($, flag)
      if (disk.isOn !== held.isOn || disk.since !== held.since) {
        await update($, flag, () => disk)
        if (disk.isOn && (!held.isOn || disk.since !== held.since)) {
          void onEnter($).catch(() => {})
        }
      }
      return disk
    } finally {
      syncing = undefined
    }
  })()
  return syncing
}

async function setAway($: Engine, isOn: boolean): Promise<AwayModeFlag> {
  const next: AwayModeFlag = { isOn, since: await $.clock.now() }
  await $.fs.write(await flagPath($), JSON.stringify(next))
  if (syncing) await syncing.catch(() => OFF)
  return sync($)
}

/** A new away period: start the tally over, and unstick a pending question. */
async function onEnter($: Engine): Promise<void> {
  nudges = 0
  await update($, log, () => [])
  if (isTurnRunning) return // the Stop hook takes care of a running turn
  const last = await lastAssistantText($)
  if (await looksWaiting($, last)) {
    await record($, 'resume', firstLine(last))
    void $.prompt.submit({ text: RESUME }).catch(() => {})
  }
}

async function lastAssistantText($: Engine): Promise<string> {
  const rows = await $.session.messages()
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row?.role === 'assistant' && row.text.trim() !== '') return row.text
  }
  return ''
}

async function record($: Engine, kind: AwayModeEventKind, text: string) {
  const at = await $.clock.now()
  await update($, log, list =>
    [...list, { at, kind, text: text.slice(0, 160) }].slice(-100),
  )
}

function firstLine(text: string): string {
  const lines = text.trim().split('\n').filter(l => l.trim() !== '')
  return (lines.at(-1) ?? '').trim()
}

const KIND_LABEL: Record<AwayModeEventKind, string> = {
  question: '拦下提问',
  plan: '拦下计划模式',
  nudge: '推回继续',
  resume: '自动续跑',
}

function tally(events: readonly AwayModeEvent[]) {
  const count = (k: AwayModeEventKind) => events.filter(x => x.kind === k).length
  return {
    asks: count('question') + count('plan'),
    nudges: count('nudge'),
    resumes: count('resume'),
  }
}

function minutes(from: number, to: number): number {
  return Math.max(0, Math.round((to - from) / 60000))
}

function report(events: readonly AwayModeEvent[], since: number, now: number): string {
  const t = tally(events)
  const head = `本会话出门期间（${minutes(since, now)} 分钟）：拦下提问 ${t.asks} 次 · 推回继续 ${t.nudges} 次 · 自动续跑 ${t.resumes} 次`
  if (events.length === 0) return head
  const rows = events
    .slice(-12)
    .map(x => `  · ${KIND_LABEL[x.kind]}：${x.text}`)
  return [head, ...rows, 'Claude 的选择和理由见它汇报里的「出门期间的决策」。'].join('\n')
}

// ── hooks ────────────────────────────────────────────────────────────────────
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'away',
      description: '出门模式开关（所有会话）：不提问、不等确认，按最佳方案推进',
      argumentHint: '[on|off|status]',
      immediate: true,
    })
    await sync($)
    $.clock.every(POLL_MS, () => {
      void sync($).catch(() => {})
    })
    return next(e)
  })

  // /away            toggle
  // /away on | off   set
  // /away status     show what happened so far
  on('command.run', { command: 'away' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const current = await sync($)
    const now = await $.clock.now()

    if (arg === 'status' || arg === 'log') {
      const events = await read($, log)
      return {
        text: current.isOn
          ? `🚶 出门模式开启中（所有会话）。\n${report(events, current.since, now)}`
          : '🏠 出门模式未开启。/away 开启。',
      }
    }

    const wantOn =
      arg === 'on' || arg === '开'
        ? true
        : arg === 'off' || arg === '关'
          ? false
          : !current.isOn

    if (wantOn === current.isOn) {
      return { text: wantOn ? '🚶 出门模式本来就开着。' : '🏠 出门模式本来就关着。' }
    }

    if (wantOn) {
      await setAway($, true)
      return {
        text:
          '🚶 出门模式已开启（所有会话）。\n' +
          'Claude 不再提问、不停下等确认，按最佳方案推进；不可逆/对外操作挂到「⏸ 等你回来」清单。\n' +
          '回来后输入 /away，或点提示栏上的「我回来了」。',
      }
    }

    const events = await read($, log)
    await setAway($, false)
    return {
      text: `🏠 出门模式已关闭（所有会话）。\n${report(events, current.since, now)}`,
    }
  })

  // ── system prompt ──
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const current = await sync($).catch(() => OFF)
    if (!current.isOn) return composed
    return {
      sections: [
        ...composed.sections,
        { id: 'away-mode:policy', text: POLICY, scope: 'session' },
      ],
    }
  })

  // ── tools that wait on the person ──
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const current = await sync($)
    if (!current.isOn) return next(e)
    await record($, 'question', e.questions.map(q => q.question).join(' / '))
    return { deny: DENY_ASK }
  })

  on('tool.call', { tool: 'EnterPlanMode' }, async ($, e, next) => {
    const current = await sync($)
    if (!current.isOn) return next(e)
    await record($, 'plan', '想进入计划模式')
    return { deny: DENY_PLAN }
  })

  // ── a turn that ends on a question goes back to work ──
  on('classic.Stop', async ($, e, next) => {
    const settled = await next(e)
    if (settled.block !== undefined || settled.preventContinuation) return settled

    const current = await sync($)
    const text = e.last_assistant_message ?? ''
    if (!current.isOn || nudges >= MAX_NUDGES || !(await looksWaiting($, text))) {
      nudges = 0
      return settled
    }

    nudges += 1
    await record($, 'nudge', firstLine(text))
    return { ...settled, block: NUDGE }
  })

  // ── is a main-loop turn running? (onEnter leaves a running turn alone) ──
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) isTurnRunning = true
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) isTurnRunning = false
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    nudges = 0
    return next(e)
  })

  // ── the band above the prompt ──
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const current = await read($, flag)
    if (!current.isOn) return next(e)

    const t = tally(await read($, log))
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text color="warning" weight="bold">
          🚶 出门模式
        </Text>
        <Text dimColor>
          {'  '}所有会话 · 拦下提问 {t.asks} · 推回继续 {t.nudges} · 自动续跑 {t.resumes}
          {'  '}
        </Text>
        <Button
          key="back"
          label="我回来了"
          hotkey="b"
          onPress={async () => {
            const events = await read($, log)
            const now = await $.clock.now()
            await setAway($, false)
            $.ui.toast(`🏠 欢迎回来。${report(events, current.since, now).split('\n')[0]}`, {
              timeoutMs: 8000,
            })
          }}
        />
      </Box>
    )
  })
}
