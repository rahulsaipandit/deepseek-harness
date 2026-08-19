/**
 * Dispatches one parsed client frame to a `TerminalWsBridge` and produces
 * the resulting server frame(s) via a `send` callback. Kept free of `ws`
 * itself so it's testable with a fake bridge and a captured `send`.
 * @module dsh-plugin-web-terminal/dispatch
 */

import type { ClientMessage, ServerMessage } from './domain.ts'
import type { TerminalWsBridge } from './session-bridge.ts'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Handle one already-authenticated client frame. `hello` frames past the initial handshake are ignored (already authenticated). */
export async function dispatchClientMessage(
  bridge: TerminalWsBridge,
  message: ClientMessage,
  send: (frame: ServerMessage) => void,
): Promise<void> {
  switch (message.type) {
    case 'hello':
      return
    case 'input': {
      try {
        const result = await bridge.sendLine(message.text, message.submit, (read) => {
          send({ type: 'output', delta: read.delta, truncated: read.truncated })
        })
        send({
          type: 'settled',
          viewport: result.viewport,
          waitReason: result.waitReason,
          exited: result.sessionStatus.kind === 'exited',
        })
      } catch (error: unknown) {
        send({ type: 'error', code: 'send_failed', message: errorMessage(error) })
      }
      return
    }
    case 'read': {
      try {
        const result = bridge.read({
          ...message.offset !== undefined ? { offset: message.offset } : {},
          ...message.count !== undefined ? { count: message.count } : {},
        })
        send({
          type: 'read_result',
          text: result.text,
          totalLines: result.totalLines,
          lineBegin: result.lineBegin,
          lineEnd: result.lineEnd,
          truncated: result.truncated,
        })
      } catch (error: unknown) {
        send({ type: 'error', code: 'read_failed', message: errorMessage(error) })
      }
      return
    }
    case 'signal': {
      try {
        const result = await bridge.signal(message.signal)
        send({ type: 'signal_delivered', targetPgid: result.targetPgid })
      } catch (error: unknown) {
        send({ type: 'error', code: 'signal_failed', message: errorMessage(error) })
      }
      return
    }
  }
}
