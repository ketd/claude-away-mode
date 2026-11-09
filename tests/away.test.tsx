import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const FILE = '/home/me/.claude/away-mode.json'

const ASK = {
  tool: 'AskUserQuestion' as const,
  questions: [
    {
      question: 'Which library?',
      header: 'Lib',
      multiSelect: false,
      options: [
        { label: 'A', description: 'a' },
        { label: 'B', description: 'b' },
      ],
    },
  ],
}

const COMPOSE = {
  model: "claude-opus-5-5",
  promptModel: "claude-opus-5-5",
  surfaces: ["terminal"],
  tools: ["AskUserQuestion"],
  outputStyle: null,
  traits: [],
} as const

const BAND = {
  plugin: 'away-mode',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const away = (args: string) => ({
  command: 'away',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 120 },
})

/** The engine beneath the mod: a flag file in memory, HOME, a clock. */
function world(
  on: On,
  initial?: { isOn: boolean; since: number },
  messages: { role: 'user' | 'assistant'; text: string; toolUses: [] }[] = [],
) {
  const disk = { text: initial ? JSON.stringify(initial) : undefined } as {
    text: string | undefined
  }
  mock.env(on, { HOME: '/home/me' })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('fs.read', (_, e) => {
    if (e.path !== FILE || disk.text === undefined) throw new Error('ENOENT')
    return { value: disk.text }
  })
  on('fs.write', (_, e) => {
    if (e.path === FILE) disk.text = e.text
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'away' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: messages }))
  on('tool.call', () => ({ result: { text: 'answered' } }))
  on('prompt.compose', () => ({
    sections: [{ id: 'intro', text: 'base', scope: 'shared' }],
  }))
  on('classic.Stop', () => ({}))
  return Object.assign(disk, { settle: () => clock.settle() })
}

test('off: a question goes through to the person', async ($, on) => {
  world(on)
  const ran = await $.tool.call(ASK)
  expect(ran.deny).toBeUndefined()
})

test('on: a question is refused with the away policy', async ($, on) => {
  world(on, { isOn: true, since: 1 })
  const ran = await $.tool.call(ASK)
  expect(ran.isError ?? ran.deny !== undefined).toBe(true)
  expect(String(ran.text ?? ran.deny)).toContain('出门模式')
})

test('/away toggles the shared file and the system prompt', async ($, on) => {
  const disk = world(on)

  const before = await $.prompt.compose(COMPOSE)
  expect(before.sections.map(s => s.id)).not.toContain('away-mode:policy')

  const turnedOn = await $.command.run(away(''))
  expect(turnedOn.text).toContain('已开启')
  expect(JSON.parse(disk.text ?? '{}').isOn).toBe(true)

  const during = await $.prompt.compose(COMPOSE)
  expect(during.sections.map(s => s.id)).toContain('away-mode:policy')

  const turnedOff = await $.command.run(away('off'))
  expect(turnedOff.text).toContain('已关闭')
  expect(JSON.parse(disk.text ?? '{}').isOn).toBe(false)

  const after = await $.prompt.compose(COMPOSE)
  expect(after.sections.map(s => s.id)).not.toContain('away-mode:policy')
})

test('on: a turn that ends on a question is sent back to work', async ($, on) => {
  world(on, { isOn: true, since: 1 })
  on('model.classify', () => ({ value: 'waiting_for_user_answer' }))

  const asked = await $.classic.Stop({
    stop_hook_active: false,
    last_assistant_message: '方案 A 和方案 B 都可以，你想选哪个？',
  })
  expect(asked.block).toContain('出门模式')
})

test('on: the marker lets the turn end', async ($, on) => {
  world(on, { isOn: true, since: 1 })
  on('model.classify', () => ({ value: 'waiting_for_user_answer' }))

  const blocked = await $.classic.Stop({
    stop_hook_active: false,
    last_assistant_message: '⏸ 等你回来\n- 需要你登录 gcloud',
  })
  expect(blocked.block).toBeUndefined()
})

test('on: a finished turn ends normally, and nudges stop at the cap', async ($, on) => {
  world(on, { isOn: true, since: 1 })
  let label = 'not_waiting_for_user'
  on('model.classify', () => ({ value: label }))

  const done = await $.classic.Stop({
    stop_hook_active: false,
    last_assistant_message: '全部完成，测试通过。',
  })
  expect(done.block).toBeUndefined()

  label = 'waiting_for_user_answer'
  const blocks: boolean[] = []
  for (let i = 0; i < 6; i++) {
    const r = await $.classic.Stop({
      stop_hook_active: true,
      last_assistant_message: '要我继续吗？',
    })
    blocks.push(r.block !== undefined)
  }
  expect(blocks).toEqual([true, true, true, true, true, false])
})

test('classifier down: the heuristic still catches a question', async ($, on) => {
  world(on, { isOn: true, since: 1 })
  on('model.classify', () => {
    throw new Error('offline')
  })

  const r = await $.classic.Stop({
    stop_hook_active: false,
    last_assistant_message: '改好了。要我顺便把测试也补上吗？',
  })
  expect(r.block).toBeDefined()
})

test('off: Stop is left alone', async ($, on) => {
  world(on)
  on('model.classify', () => ({ value: 'waiting_for_user_answer' }))
  const r = await $.classic.Stop({
    stop_hook_active: false,
    last_assistant_message: '你想选哪个？',
  })
  expect(r.block).toBeUndefined()
})

test('the band shows while away and "我回来了" turns it off', async ($, on) => {
  const disk = world(on, { isOn: true, since: 1 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /出门模式/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'back' })
  expect(JSON.parse(disk.text ?? '{}').isOn).toBe(false)
  await ui.unmount()
})

test('turning on while Claude sits on a question sends it back to work', async ($, on) => {
  const w = world(on, undefined, [
    { role: 'user', text: '重构一下', toolUses: [] },
    { role: 'assistant', text: '有两种拆法，你倾向 A 还是 B？', toolUses: [] },
  ])
  on('model.classify', () => ({ value: 'waiting_for_user_answer' }))
  const submitted: string[] = []
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })

  await $.command.run(away('on'))
  await w.settle()

  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('出门模式自动发送')
})
