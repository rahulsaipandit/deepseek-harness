// @vitest-environment jsdom
//
// Covers this port's `background/approval-coordinator.ts` (ported unchanged
// from upstream): delivery, timeout, and decision routing.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalCoordinator } from '../src/background/approval-coordinator.ts'
import type { ApprovalPrompt } from '../src/security/approval.ts'

const PROMPT: ApprovalPrompt = {
  kind: 'action',
  action: 'browser_click',
  summary: 'Click element [1]',
  origins: ['https://app.example'],
  canTrust: true,
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ApprovalCoordinator', () => {
  it('delivers to an open panel and resolves on a decision', async () => {
    const coordinator = new ApprovalCoordinator({
      deliver: vi.fn(() => true),
      notify: vi.fn(),
      clearNotification: vi.fn(),
      resolved: vi.fn(),
    })
    const promise = coordinator.request(PROMPT, new AbortController().signal, 1)
    // Fetch the minted request id via replay (the only way to observe it from outside).
    let requestId: string | undefined
    coordinator.replay((request) => { requestId = request.id; return true })
    coordinator.respond(requestId!, 'allow-once')
    await expect(promise).resolves.toEqual({ status: 'decision', decision: 'allow-once' })
  })

  it('falls back to an OS notification when no panel can display the prompt', () => {
    const notify = vi.fn()
    const coordinator = new ApprovalCoordinator({
      deliver: vi.fn(() => false),
      notify,
      clearNotification: vi.fn(),
      resolved: vi.fn(),
    })
    void coordinator.request(PROMPT, new AbortController().signal, 1)
    expect(notify).toHaveBeenCalledOnce()
  })

  it('settles as cancelled immediately for an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const coordinator = new ApprovalCoordinator({
      deliver: vi.fn(() => true),
      notify: vi.fn(),
      clearNotification: vi.fn(),
      resolved: vi.fn(),
    })
    await expect(coordinator.request(PROMPT, controller.signal, 1)).resolves.toEqual({ status: 'cancelled' })
  })

  it('times out after the configured window with no response', async () => {
    vi.useFakeTimers()
    const coordinator = new ApprovalCoordinator({
      deliver: vi.fn(() => true),
      notify: vi.fn(),
      clearNotification: vi.fn(),
      resolved: vi.fn(),
    }, 100)
    const promise = coordinator.request(PROMPT, new AbortController().signal, 1)
    await vi.advanceTimersByTimeAsync(101)
    await expect(promise).resolves.toEqual({ status: 'timed-out' })
  })

  it('cancelAll settles every pending request as cancelled', async () => {
    const coordinator = new ApprovalCoordinator({
      deliver: vi.fn(() => true),
      notify: vi.fn(),
      clearNotification: vi.fn(),
      resolved: vi.fn(),
    })
    const a = coordinator.request(PROMPT, new AbortController().signal, 1)
    const b = coordinator.request(PROMPT, new AbortController().signal, 1)
    coordinator.cancelAll()
    await expect(a).resolves.toEqual({ status: 'cancelled' })
    await expect(b).resolves.toEqual({ status: 'cancelled' })
  })
})
