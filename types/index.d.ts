/** The switch every session shares, as the flag file holds it. */
export type AwayModeFlag = { isOn: boolean; since: number }

/**
 * What the mode did in this session while it was on:
 * `question` an AskUserQuestion it refused, `plan` an EnterPlanMode it refused,
 * `nudge` a stop it sent back to work, `resume` an idle question it answered
 * with "go on" when the mode turned on.
 */
export type AwayModeEventKind = 'question' | 'plan' | 'nudge' | 'resume'

export type AwayModeEvent = { at: number; kind: AwayModeEventKind; text: string }

declare module 'claude-code' {
  interface PluginState {
    'away-mode': {
      flag: AwayModeFlag
      log: Shaped<AwayModeEvent[]>
    }
  }
}
