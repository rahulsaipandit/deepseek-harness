/**
 * Model-facing browser page context injected after an explicit tab handoff.
 *
 * The extension captures the page immediately after the user chooses to
 * follow it. A live Agent receives that snapshot at once; a not-yet-published
 * (deferred/provisional) session keeps only its newest snapshot until
 * `agent/created` publishes the Agent. Injection deliberately does not wake an
 * idle Agent — the snapshot is claimed together with the user's next message.
 *
 * Ported from github.com/Lum1104/dsh-browser
 * (`packages/browser/bridge-browser/src/browser-context.ts`). Adapted: this
 * repo's live-agent registry is `ctx.agents` (`@deepseek-ai/dsh-agent`'s
 * `AgentRegistry`, confirmed at `packages/core/agent/src/index.ts`) and the
 * publish event is `agent/created` (this repo has no `agent/session-start`
 * event; `agent/created` is the equivalent "agent just became live" hook,
 * see `packages/core/agent/src/runtime-types.ts`). The message-source shape
 * (`kind: 'plugin'`, `form: 'snapshot'`, `sections`) matches upstream exactly
 * because this repo's `MessageSourceMap` already carries that contract
 * (`packages/llm/llm/src/message.ts`).
 *
 * @module
 */

import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

/** Provenance key used for snapshot supersession and transcript presentation. */
export const BROWSER_CONTEXT_PLUGIN = 'dsh-plugin-browser-bridge'

/** Bound orphaned provisional sessions while retaining normal recent tabs. */
const DEFAULT_MAX_PENDING = 32

/** Build one immutable context message from a captured browser snapshot. */
export function createBrowserSnapshotMessage(snapshot: string): UserMessage {
  const text = [
    'The user chose to follow the newly active browser tab. The browser page context was refreshed immediately after that choice.',
    'The following browser_snapshot is the current page state. Use it for the next request instead of asking whether the page was read.',
    snapshot,
  ].join('\n\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: BROWSER_CONTEXT_PLUGIN,
      form: 'snapshot',
      sections: [{ name: 'browser-page', text }],
    },
  })
}

/** Deliver followed-page snapshots to live or not-yet-materialized Agents. */
export class BrowserContextInjector {
  private readonly pending = new Map<string, string>()

  constructor(
    private readonly agents: Pick<AgentRegistry, 'get'>,
    private readonly maxPending = DEFAULT_MAX_PENDING,
  ) {
    if (!Number.isInteger(maxPending) || maxPending < 1) {
      throw new Error('browser-bridge: browser context maxPending must be a positive integer')
    }
  }

  /** Inject now when possible; otherwise retain the newest snapshot per session. */
  inject(sessionId: string, snapshot: string): 'injected' | 'queued' {
    const agent = this.agents.get(sessionId as Parameters<AgentRegistry['get']>[0])
    if (agent !== undefined) {
      this.pending.delete(sessionId)
      agent.inject(createBrowserSnapshotMessage(snapshot))
      return 'injected'
    }

    // Refresh insertion order when the same provisional session follows again.
    this.pending.delete(sessionId)
    while (this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.pending.delete(oldest)
    }
    this.pending.set(sessionId, snapshot)
    return 'queued'
  }

  /** Flush one provisional session at the supported Agent startup boundary. */
  activate(agent: Agent): boolean {
    const sessionId = String(agent.id)
    const snapshot = this.pending.get(sessionId)
    if (snapshot === undefined) return false
    agent.inject(createBrowserSnapshotMessage(snapshot))
    this.pending.delete(sessionId)
    return true
  }
}
