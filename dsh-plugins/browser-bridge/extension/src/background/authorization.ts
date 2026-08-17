/**
 * Pure authorization policy for model-requested browser tools.
 *
 * Ported from github.com/Lum1104/dsh-browser
 * (`extensions/dsh-browser/src/background/authorization.ts`). Adapted: this
 * port simplifies upstream's full per-frame origin resolution (`frames.ts`,
 * `TabFrame[]`, `webNavigation.getAllFrames`) to a single top-level page
 * origin — see this package's README "Trust and limitations" section (no
 * iframe-scoped approval/trust boundary; every call is evaluated against the
 * top-level tab's origin only). The security-relevant policy itself is
 * unchanged: page reads only prompt when `sharePageContent === 'ask'`,
 * state-changing actions always prompt unless the exact single origin is
 * already trusted, and `browser_navigate`/`browser_back`/`browser_forward`
 * can never mark an origin trustable when the destination is unknown or
 * cross-origin (`canTrust` stays false for exactly the same reasons as
 * upstream).
 *
 * @module
 */

import type { ApprovalPrompt } from '../security/approval.ts'

/** One model-requested browser tool call, as delivered by the bridge. */
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  sessionId?: string
}

const PAGE_READS = new Set(['browser_snapshot', 'browser_get_text'])
const STATE_CHANGING_ACTIONS = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
])

/**
 * Return an approval prompt, or undefined when this call needs no prompt.
 * @param call - the tool call to authorize.
 * @param sharePageContent - the user's page-read policy ('ask'/'auto'/'off').
 * @param pageUrl - the current top-level page URL (single-frame simplification).
 */
export function approvalPromptForCall(
  call: ToolCall,
  sharePageContent: 'ask' | 'auto' | 'off',
  pageUrl: string,
): ApprovalPrompt | undefined {
  const pageOrigin = originFromUrl(pageUrl)

  if (PAGE_READS.has(call.name)) {
    if (sharePageContent !== 'ask') return undefined
    return {
      kind: 'read',
      action: call.name,
      summary: call.name === 'browser_snapshot'
        ? 'Read the current page'
        : 'Read text from the specified area of the current page',
      origins: pageOrigin === undefined ? [] : [pageOrigin],
      canTrust: false,
    }
  }

  if (!STATE_CHANGING_ACTIONS.has(call.name)) return undefined

  const origins = pageOrigin === undefined ? [] : [pageOrigin]
  let canTrust = origins.length === 1 && call.name !== 'browser_back' && call.name !== 'browser_forward'
  if (call.name === 'browser_navigate') {
    const destination = originFromUrl(typeof call.args.url === 'string' ? call.args.url : '')
    if (destination !== undefined && !origins.includes(destination)) origins.push(destination)
    // Do not let an invalid, opaque, or cross-origin navigation become a
    // back door for adding the current page to the persistent allowlist.
    canTrust = destination !== undefined && origins.length === 1 && origins[0] === destination
  }
  return {
    kind: 'action',
    action: call.name,
    summary: summarizeAction(call),
    origins,
    // Cross-origin/invalid navigation and unknown history destinations always
    // require a fresh decision; they must never expand trust implicitly.
    canTrust,
  }
}

export function originFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'blob:') return undefined
    return url.origin === 'null' ? undefined : url.origin
  } catch {
    return undefined
  }
}

function summarizeAction(call: ToolCall): string {
  const index = typeof call.args.index === 'number' ? call.args.index : '?'
  switch (call.name) {
    case 'browser_click': return `Click element [${index}]`
    case 'browser_type': {
      const length = typeof call.args.text === 'string' ? call.args.text.length : 0
      return `Enter ${length} characters in element [${index}] (the text is not shown in this dialog)`
    }
    case 'browser_press': return `Press "${safeInline(typeof call.args.key === 'string' ? call.args.key : '')}"`
    case 'browser_navigate': return `Navigate to ${displayUrl(typeof call.args.url === 'string' ? call.args.url : '')}`
    case 'browser_back': return 'Go back in browser history (destination domain unknown)'
    case 'browser_forward': return 'Go forward in browser history (destination domain unknown)'
    case 'browser_reload': return 'Reload the current page'
    default: return call.name
  }
}

function displayUrl(value: string): string {
  try {
    const url = new URL(value)
    return safeInline(`${url.origin}${url.pathname}`, 160)
  } catch {
    return '(invalid URL)'
  }
}

function safeInline(value: string, maxLength = 40): string {
  const inline = value.replace(/\s+/g, ' ').trim()
  return inline.length <= maxLength ? inline : `${inline.slice(0, maxLength - 1)}…`
}
