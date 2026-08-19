import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalWsBridge, type AgentsPort, type TerminalsPort } from '../src/session-bridge.ts'

function makeFakePorts() {
  const disposedOwners: string[] = []
  const killed: { sessionId: string; reason: string | undefined }[] = []
  let sendCallCount = 0

  const agents: AgentsPort = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow structural fake, only .id matters
    async create(options): Promise<any> {
      const agent = { id: options.sessionId }
      return { agent, dispose: async () => { disposedOwners.push(String(options.sessionId)) } }
    },
  }

  const terminals: TerminalsPort = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async spawn(_owner, request): Promise<any> {
      return { sessionId: 'pty-1', name: undefined, type: request.type, pid: 123, status: { kind: 'running' }, motd: 'welcome' }
    },
    startSend(_owner, _id, request) {
      sendCallCount += 1
      let resolveDone: (value: any) => void // eslint-disable-line @typescript-eslint/no-explicit-any
      const done = new Promise<any>((resolve) => { resolveDone = resolve }) // eslint-disable-line @typescript-eslint/no-explicit-any
      let delivered = ''
      const chunks = [`echo of: ${request.text}`, ' (more output)']
      let chunkIndex = 0
      const timer = setInterval(() => {
        if (chunkIndex < chunks.length) {
          delivered += chunks[chunkIndex]
          chunkIndex += 1
        } else {
          clearInterval(timer)
          resolveDone({
            viewport: delivered,
            waitReason: 'inferred_idle',
            sessionStatus: { kind: 'running' },
            truncated: false,
          })
        }
      }, 50)
      let readSoFar = ''
      return {
        done,
        readOutput: () => {
          const unread = delivered.slice(readSoFar.length)
          readSoFar = delivered
          return { delta: unread, truncated: false }
        },
        cancel: () => { clearInterval(timer); return true },
      }
    },
    read(_owner, _id, request) {
      return { text: 'scrollback', totalLines: 10, lineBegin: request?.offset ?? 0, lineEnd: 10, truncated: false }
    },
    async signal(_owner, _id, signal) {
      return { delivered: true, targetPgid: signal === 'SIGINT' ? 999 : 0 }
    },
    async kill(_owner, id, reason) {
      killed.push({ sessionId: String(id), reason })
      return true
    },
  }

  return { agents, terminals, disposedOwners, killed, sendCallCount: () => sendCallCount }
}

describe('TerminalWsBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('throws if used before open() resolves', () => {
    const { agents, terminals } = makeFakePorts()
    const bridge = new TerminalWsBridge(agents, terminals, 'shell')
    expect(() => bridge.read()).toThrow(/before open\(\)/)
  })

  it('opens a session and returns the motd', async () => {
    const { agents, terminals } = makeFakePorts()
    const bridge = new TerminalWsBridge(agents, terminals, 'shell')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SessionId is a branded string; a plain string suffices for this fake
    const result = await bridge.open('owner-session-1' as any)
    expect(result).toEqual({ motd: 'welcome' })
  })

  it('streams incremental deltas while a send is in flight, then settles', async () => {
    const { agents, terminals } = makeFakePorts()
    const bridge = new TerminalWsBridge(agents, terminals, 'shell')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await bridge.open('owner-session-1' as any)

    const deltas: string[] = []
    const donePromise = bridge.sendLine('ls', true, (read) => { deltas.push(read.delta) }, 50)
    await vi.advanceTimersByTimeAsync(150)
    const result = await donePromise

    expect(deltas.join('')).toBe('echo of: ls (more output)')
    expect(result.waitReason).toBe('inferred_idle')
  })

  it('reads scrollback', async () => {
    const { agents, terminals } = makeFakePorts()
    const bridge = new TerminalWsBridge(agents, terminals, 'shell')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await bridge.open('owner-session-1' as any)
    expect(bridge.read({ offset: 5 })).toEqual({ text: 'scrollback', totalLines: 10, lineBegin: 5, lineEnd: 10, truncated: false })
  })

  it('delivers a signal', async () => {
    const { agents, terminals } = makeFakePorts()
    const bridge = new TerminalWsBridge(agents, terminals, 'shell')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await bridge.open('owner-session-1' as any)
    const result = await bridge.signal('SIGINT')
    expect(result).toEqual({ delivered: true, targetPgid: 999 })
  })

  it('kills the PTY session and disposes the owner agent on close', async () => {
    const { agents, terminals, disposedOwners, killed } = makeFakePorts()
    const bridge = new TerminalWsBridge(agents, terminals, 'shell')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await bridge.open('owner-session-1' as any)
    await bridge.close('test teardown')

    expect(killed).toEqual([{ sessionId: 'pty-1', reason: 'test teardown' }])
    expect(disposedOwners).toEqual(['owner-session-1'])
  })

  it('close is a no-op when open() never resolved', async () => {
    const { agents, terminals, disposedOwners, killed } = makeFakePorts()
    const bridge = new TerminalWsBridge(agents, terminals, 'shell')
    await bridge.close()
    expect(killed).toEqual([])
    expect(disposedOwners).toEqual([])
  })
})
