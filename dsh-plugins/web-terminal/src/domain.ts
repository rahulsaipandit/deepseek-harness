/**
 * Wire protocol for the web-terminal WebSocket route: parsing/validating raw
 * client frames into a closed message union. No I/O, no ctx — kept separate
 * so it's testable without a real socket. Every frame is a single JSON
 * object; there is no binary framing.
 *
 * The interaction model this protocol exposes is deliberately
 * **line-oriented, not a raw byte-streaming PTY**: `ctx.terminals`'
 * `TerminalBackendSession` contract ("one session accepts at most one live
 * send operation … `startSend({text, submit})`") is a command/response
 * seam, not an open bidirectional byte pipe — so this plugin cannot offer a
 * true interactive terminal (no per-keystroke echo, `vim`/`less` would be a
 * poor experience). It offers a solid single-command-at-a-time remote
 * console instead, which is what the underlying capability actually
 * supports. See the package README's "What it is not" section.
 * @module dsh-plugin-web-terminal/domain
 */

const SIGNAL_VALUES = ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP'] as const

/** Kept member-identical to `@deepseek-ai/dsh-terminal`'s `TerminalSignal` without importing it into this pure module. */
export type WebTerminalSignal = typeof SIGNAL_VALUES[number]

export type ClientMessage =
  | { readonly type: 'hello'; readonly token: string }
  | { readonly type: 'input'; readonly text: string; readonly submit: boolean }
  | { readonly type: 'signal'; readonly signal: WebTerminalSignal }
  | { readonly type: 'read'; readonly offset?: number; readonly count?: number }

export interface ProtocolError {
  readonly code: 'invalid_frame'
  readonly message: string
}

export type ServerMessage =
  | { readonly type: 'motd'; readonly text: string }
  | { readonly type: 'output'; readonly delta: string; readonly truncated: boolean }
  | { readonly type: 'settled'; readonly viewport: string; readonly waitReason: string; readonly exited: boolean }
  | { readonly type: 'read_result'; readonly text: string; readonly totalLines: number; readonly lineBegin: number; readonly lineEnd: number; readonly truncated: boolean }
  | { readonly type: 'signal_delivered'; readonly targetPgid: number }
  | { readonly type: 'error'; readonly code: string; readonly message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Parse and validate one raw client frame. Never throws — an unparsable or ill-shaped frame is a `ProtocolError`, not an exception. */
export function parseClientMessage(raw: string): ClientMessage | ProtocolError {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { code: 'invalid_frame', message: 'frame is not valid JSON.' }
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    return { code: 'invalid_frame', message: 'frame must be a JSON object with a string "type".' }
  }
  switch (parsed.type) {
    case 'hello': {
      if (typeof parsed.token !== 'string' || parsed.token.length === 0) {
        return { code: 'invalid_frame', message: 'hello requires a non-empty string "token".' }
      }
      return { type: 'hello', token: parsed.token }
    }
    case 'input': {
      if (typeof parsed.text !== 'string' || typeof parsed.submit !== 'boolean') {
        return { code: 'invalid_frame', message: 'input requires string "text" and boolean "submit".' }
      }
      return { type: 'input', text: parsed.text, submit: parsed.submit }
    }
    case 'signal': {
      if (typeof parsed.signal !== 'string' || !(SIGNAL_VALUES as readonly string[]).includes(parsed.signal)) {
        return { code: 'invalid_frame', message: `signal must be one of ${SIGNAL_VALUES.join(', ')}.` }
      }
      return { type: 'signal', signal: parsed.signal as WebTerminalSignal }
    }
    case 'read': {
      if (parsed.offset !== undefined && typeof parsed.offset !== 'number') {
        return { code: 'invalid_frame', message: 'read "offset" must be a number when present.' }
      }
      if (parsed.count !== undefined && typeof parsed.count !== 'number') {
        return { code: 'invalid_frame', message: 'read "count" must be a number when present.' }
      }
      return {
        type: 'read',
        ...parsed.offset !== undefined ? { offset: parsed.offset } : {},
        ...parsed.count !== undefined ? { count: parsed.count } : {},
      }
    }
    default:
      return { code: 'invalid_frame', message: `unknown frame type "${parsed.type}".` }
  }
}
