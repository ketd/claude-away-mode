# away-mode · 出门模式

A Claude Code plugin for when you step away from the keyboard. Type `/away` and Claude stops asking questions and stops pausing for confirmation: it picks the option it would have recommended, keeps working, and logs every judgment call for you to review when you're back. Irreversible or outward-facing actions are still held for you.

给 Claude Code 用的"出门模式"。出门前输入 `/away`，Claude 就不再提问、不再停下等你确认，自己挑推荐方案一口气做完，并把每个自主决策记下来等你回来看。不可逆、对外的操作仍然留给你。

## Install · 安装

At the prompt of a Claude Code terminal session · 在 Claude Code 终端会话里输入：

```
/plugin install away-mode --marketplace ketd/claude-away-mode
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).
回答 `y` 添加 marketplace，再选作用范围（选 user 就是所有会话都生效）。

From a shell · 在命令行里：

```
claude plugin install away-mode --marketplace ketd/claude-away-mode
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `ketd/claude-away-mode`, then **Add plugin**.
桌面 App 里 `/plugin` 用不了：点输入框旁边的 **+** → **Plugins** → **Add marketplace** 填 `ketd/claude-away-mode` → **Add plugin**。

## Usage · 用法

| Command · 命令 | What it does · 作用 |
| --- | --- |
| `/away` | Toggle · 开关切换（Claude 跑到一半时也能直接敲） |
| `/away on` · `/away off` | Set explicitly · 明确开或关 |
| `/away status` | What it intercepted so far · 看出门期间拦下了什么 |
| **我回来了** button (hotkey `b`) | Turn it off from the band above the prompt · 提示栏上一键关闭 |

The switch is shared by every session on the machine: turn it on in one terminal and every running Claude Code session with this plugin goes into away mode within a few seconds.
开关对本机所有会话共享：在一个终端打开，其他装了这个插件的会话几秒内都会进入出门模式。

## How it works · 原理

While away mode is on:

1. **No question tools.** `AskUserQuestion` and `EnterPlanMode` are refused, with a note telling Claude to take its recommended option and record the decision.
2. **A policy section in the system prompt**: finish what can be finished, log each decision as *question → choice → reason* under 「出门期间的决策」, send a push notification when done or blocked (if the PushNotification tool is available).
3. **No ending a turn on a question.** A `Stop` hook asks a small model whether Claude's last message is waiting on you; if so the turn is sent back to work. At most 5 nudges in a row, with a keyword heuristic if the classifier is unavailable.
4. **Unstick idle sessions.** When the mode turns on, any idle session whose last message was a question gets a "go with your recommendation" prompt.

开启期间：拒绝提问工具和计划模式；系统提示加一节出门规则；Claude 想以问句结束回合时，用 Stop hook 把它推回去（连续最多 5 次）；打开开关时，正停在问题上的空闲会话会被自动推一把。

## Safety boundary · 安全边界

Away mode grants decisions, not new powers. Claude still does **not** run `git push`, open or merge PRs, deploy, delete data or files, message other people, spend money, or change live resources. It prepares everything up to that point, lists the step under 「⏸ 等你回来」 (*waiting for you*), and moves on to other work. If nothing else can move forward, it writes that list and ends the turn; the plugin lets a turn containing that marker end without a nudge. No permission rule is changed.

出门模式只授权"做决定"，不授权新能力：push、PR、部署、删除、给别人发消息、付费、改线上资源一律挂起，写进「⏸ 等你回来」清单。权限规则不变。

## Notes · 说明

- The policy and nudge texts are written in Chinese; Claude follows them in any language.
  规则文本是中文写的，Claude 用任何语言都能照做。
- The shared switch lives in `~/.claude/away-mode.json` (`{"isOn": true, "since": <ms>}`). If Claude seems to never ask anything, check that file.
  开关文件在 `~/.claude/away-mode.json`。如果 Claude 一直不提问，先看这个文件是不是还开着。
- A session that is already in plan mode when you leave still needs you to approve leaving it.
  出门前已经处在计划模式的会话，退出计划模式仍需你批准。
- Toggling changes the system prompt, so the next request re-reads the prompt cache once.
  每次开关会改系统提示，下一次请求会重建一次提示缓存。

## Development · 开发

```
claude plugin validate .
claude plugin test .
```

## License

MIT
