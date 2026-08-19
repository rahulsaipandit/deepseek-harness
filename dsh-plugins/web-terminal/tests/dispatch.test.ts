import { describe, expect, it, vi } from 'vitest'
import { dispatchClientMessage } from '../src/dispatch.ts'
import type { ServerMessage } from '../src/domain.ts'
import type { TerminalWsBridge } from '../src/session-bridge.ts'

function fakeBridge(overrides: Partial<TerminalWsBridge> = {}): TerminalWsBridge {
  return {
    async sendLine(_text, _submit, onDelta) {
      onDelta({ delta: 'hello', truncated: false })
      return { viewport: 'hello', waitReason: 'inferred_idle', sessionStatus: { kind: 'running' }, truncated: false }
    },
    read: () => ({ text: 'scrollback', totalLines: 1, lineBegin: 0, lineEnd: 1, truncated: false }),
    async signal() {
      return { delivered: true, targetPgid: 42 }
    },
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow structural fake standing in for the real class
  } as any
}

function collect(): { messages: ServerMessage[]; send: (message: ServerMessage) => void } {
  const messages: ServerMessage[] = []
  return { messages, send: message => messages.push(message) }
}

describe('dispatchClientMessage', () => {
  it('ignores a late hello frame', async () => {
    const { messages, send } = collect()
    await dispatchClientMessage(fakeBridge(), { type: 'hello', token: 'x' }, send)
    expect(messages).toEqual([])
  })

  it('streams output deltas then a settled frame for input', async () => {
    const { messages, send } = collect()
    await dispatchClientMessage(fakeBridge(), { type: 'input', text: 'ls', submit: true }, send)
    expect(messages).toEqual([
      { type: 'output', delta: 'hello', truncated: false },
      { type: 'settled', viewport: 'hello', waitReason: 'inferred_idle', exited: false },
    ])
  })

  it('marks settled.exited true when the session exited', async () => {
    const { messages, send } = collect()
    const bridge = fakeBridge({
      async sendLine(_text, _submit, onDelta) {
        onDelta({ delta: 'bye', truncated: false })
        return { viewport: 'bye', waitReason: 'session_exit' as const, sessionStatus: { kind: 'exited', exitCode: 0, signal: null }, truncated: false }
      },
    })
    await dispatchClientMessage(bridge, { type: 'input', text: 'exit', submit: true }, send)
    expect(messages[1]).toEqual({ type: 'settled', viewport: 'bye', waitReason: 'session_exit', exited: true })
  })

  it('sends an error frame when sendLine throws', async () => {
    const { messages, send } = collect()
    const bridge = fakeBridge({ sendLine: vi.fn().mockRejectedValue(new Error('boom')) })
    await dispatchClientMessage(bridge, { type: 'input', text: 'ls', submit: true }, send)
    expect(messages).toEqual([{ type: 'error', code: 'send_failed', message: 'boom' }])
  })

  it('translates a read frame to read_result', async () => {
    const { messages, send } = collect()
    await dispatchClientMessage(fakeBridge(), { type: 'read', offset: 0, count: 10 }, send)
    expect(messages).toEqual([{ type: 'read_result', text: 'scrollback', totalLines: 1, lineBegin: 0, lineEnd: 1, truncated: false }])
  })

  it('sends an error frame when read throws', async () => {
    const { messages, send } = collect()
    const bridge = fakeBridge({ read: () => { throw new Error('read boom') } })
    await dispatchClientMessage(bridge, { type: 'read' }, send)
    expect(messages).toEqual([{ type: 'error', code: 'read_failed', message: 'read boom' }])
  })

  it('translates a signal frame to signal_delivered', async () => {
    const { messages, send } = collect()
    await dispatchClientMessage(fakeBridge(), { type: 'signal', signal: 'SIGINT' }, send)
    expect(messages).toEqual([{ type: 'signal_delivered', targetPgid: 42 }])
  })

  it('sends an error frame when signal throws', async () => {
    const { messages, send } = collect()
    const bridge = fakeBridge({ signal: vi.fn().mockRejectedValue(new Error('signal boom')) })
    await dispatchClientMessage(bridge, { type: 'signal', signal: 'SIGKILL' }, send)
    expect(messages).toEqual([{ type: 'error', code: 'signal_failed', message: 'signal boom' }])
  })
})
