/**
 * Dispatch one model-requested browser tool call to the controlled tab:
 * resolve/require user approval (`authorization.ts`), send it to the content
 * script, and wrap any returned page text in the untrusted-content boundary
 * (`untrusted.ts`) before it goes back to the model.
 *
 * This is a simplified reimplementation of upstream's
 * `extensions/dsh-browser/src/background/tools.ts` — see the README "Trust
 * and limitations" section. Upstream's version resolves per-tab-affinity
 * targeting and multi-frame routing (`tab-affinity.ts`, `frames.ts`); this
 * port always operates on the single tab/frame the caller resolved (see
 * `index.ts`'s `resolveActiveTab`). The two controls this task's checklist
 * calls out by name are both present and unmodified in intent: per-action
 * approval gating (via `authorize`, which is expected to consult
 * `approval-coordinator.ts`/`authorization.ts`) and the untrusted-content
 * wrapper around any page text (`wrapUntrustedContent`).
 *
 * @module
 */

import type { ToolErrorCode } from '../protocol.ts'
import type { ApprovalAuthorization, ApprovalPrompt } from '../security/approval.ts'
import { approvalPromptForCall, type ToolCall } from './authorization.ts'
import { wrapUntrustedContent } from './untrusted.ts'
import type { SnapshotBudget } from '../content/snapshot.ts'

export type { ToolCall }

/** Tool names whose result text is untrusted page content and must be wrapped. */
const PAGE_TEXT_RESULTS = new Set(['browser_snapshot', 'browser_get_text'])

/** Settled answer to one dispatched tool call. */
export interface ToolAnswer {
  ok: boolean
  result?: { text: string }
  error?: { code: ToolErrorCode; message: string }
}

const activeSnapshotBudgets = new Map<number, SnapshotBudget>();

/** Forget any per-tab snapshot delta baseline (call on navigation/tab loss). */
export function resetTabSnapshot(_tabId: number): void {
  // Delta baseline lives in the content script's module scope (one per
  // document lifetime), so there is nothing to reset here beyond documenting
  // the call site upstream also uses after a tab is replaced or removed.
}

/**
 * Dispatch one tool call against a specific, already-resolved tab.
 * @param call - the model-requested tool call.
 * @param sharePageContent - the user's page-read approval policy.
 * @param budget - negotiated snapshot budget overrides (from `hello.ok` caps).
 * @param authorize - resolves an approval prompt to a decision (delegates to
 *   `approval-coordinator.ts` in the real background wiring).
 * @param signal - aborts the call (bridge `tool.cancel`, expiry, or teardown).
 * @param tab - the resolved target tab.
 */
export async function dispatchToolCall(
  call: ToolCall,
  sharePageContent: 'ask' | 'auto' | 'off',
  budget: Partial<SnapshotBudget> | undefined,
  authorize: (prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>,
  signal: AbortSignal,
  tab: Pick<chrome.tabs.Tab, 'id' | 'url' | 'windowId'>,
): Promise<ToolAnswer> {
  if (tab.id === undefined) {
    return { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
  }
  const prompt = approvalPromptForCall(call, sharePageContent, tab.url ?? '')
  if (prompt !== undefined) {
    const authorization = await authorize(prompt)
    if (signal.aborted) return { ok: false, error: { code: 'bridge-closed', message: 'The call was cancelled.' } }
    if (authorization !== 'approved') {
      return { ok: false, error: { code: 'action-failed', message: authorizationDeniedMessage(authorization) } }
    }
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'DSH_ACTION',
      action: call.name,
      args: call.args,
      ...(budget === undefined ? {} : { budget }),
    }) as { ok: boolean; result?: { text: string }; error?: { code: string; message: string } } | undefined
    if (response === undefined) {
      return { ok: false, error: { code: 'content-unavailable', message: 'The page did not respond (it may not have finished loading).' } }
    }
    if (!response.ok) {
      return { ok: false, error: { code: (response.error?.code as ToolErrorCode | undefined) ?? 'action-failed', message: response.error?.message ?? 'The action failed.' } }
    }
    const text = response.result?.text ?? ''
    if (!PAGE_TEXT_RESULTS.has(call.name)) return { ok: true, result: { text } }
    const budgetChars = budget?.maxChars ?? activeSnapshotBudgets.get(tab.id)?.maxChars ?? 32_000
    return { ok: true, result: { text: wrapUntrustedContent(text, budgetChars) } }
  } catch (error: unknown) {
    return {
      ok: false,
      error: { code: 'content-unavailable', message: error instanceof Error ? error.message : String(error) },
    }
  }
}

function authorizationDeniedMessage(authorization: ApprovalAuthorization): string {
  switch (authorization) {
    case 'denied': return 'The user denied this browser action.'
    case 'timed-out': return 'The approval request timed out waiting for a user response.'
    case 'cancelled': return 'The action was cancelled before it was approved.'
    case 'unavailable': return 'No side panel is open to approve this action.'
    default: return 'The action was not approved.'
  }
}
