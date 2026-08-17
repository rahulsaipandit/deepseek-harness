// @vitest-environment jsdom
//
// Adapted from github.com/Lum1104/dsh-browser
// (`extensions/dsh-browser/tests/authorization.spec.ts`), named in the port
// task as one of the security-focused specs to keep. Adapted because this
// port's `authorization.ts` takes a single top-level page URL instead of
// upstream's `TabFrame[]` (no iframe-scoped origin resolution — see the
// README "Trust and limitations" section) and has no i18n parameter (English
// only). The security-relevant assertions are unchanged in intent: page
// reads only prompt under 'ask', typed text is never echoed into the
// summary, and navigation only offers persistent trust when the destination
// origin is fully known and matches the current origin.
import { describe, expect, it } from 'vitest'
import { approvalPromptForCall, originFromUrl } from '../src/background/authorization.ts'
import type { ToolCall } from '../src/background/authorization.ts'

const PAGE_URL = 'https://app.example/page'

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: 'call', name, args }
}

describe('approvalPromptForCall', () => {
  it('asks before reading and names the page origin', () => {
    expect(approvalPromptForCall(call('browser_snapshot'), 'ask', PAGE_URL)).toMatchObject({
      kind: 'read',
      origins: ['https://app.example'],
      canTrust: false,
    })
    expect(approvalPromptForCall(call('browser_snapshot'), 'auto', PAGE_URL)).toBeUndefined()
  })

  it('scopes a same-origin action to the page origin and redacts typed text', () => {
    const prompt = approvalPromptForCall(call('browser_type', {
      index: 7,
      text: 'my-password-must-not-appear',
    }), 'auto', PAGE_URL)

    expect(prompt).toMatchObject({
      kind: 'action',
      origins: ['https://app.example'],
      canTrust: true,
    })
    expect(prompt?.summary).toContain('27 characters')
    expect(prompt?.summary).not.toContain('my-password')
  })

  it('never offers persistent trust for cross-origin navigation', () => {
    const prompt = approvalPromptForCall(call('browser_navigate', {
      url: 'https://bank.example/transfer?token=secret#confirm',
    }), 'auto', PAGE_URL)

    expect(prompt).toMatchObject({
      origins: ['https://app.example', 'https://bank.example'],
      canTrust: false,
      summary: 'Navigate to https://bank.example/transfer',
    })
    expect(prompt?.summary).not.toContain('secret')
  })

  it('does not offer trust for invalid navigation and keeps key summaries on one bounded line', () => {
    expect(approvalPromptForCall(call('browser_navigate', { url: 'javascript:alert(1)' }), 'auto', PAGE_URL))
      .toMatchObject({ canTrust: false })

    const prompt = approvalPromptForCall(call('browser_press', { key: `Enter\n${'x'.repeat(100)}` }), 'auto', PAGE_URL)
    expect(prompt?.summary).not.toContain('\n')
    expect(prompt?.summary.length).toBeLessThan(70)
  })

  it('keeps read-only viewport tools outside the approval path', () => {
    expect(approvalPromptForCall(call('browser_scroll', { direction: 'down' }), 'auto', PAGE_URL)).toBeUndefined()
    expect(approvalPromptForCall(call('browser_wait'), 'auto', PAGE_URL)).toBeUndefined()
  })

  it('never offers persistent trust for back/forward (destination domain unknown)', () => {
    expect(approvalPromptForCall(call('browser_back'), 'auto', PAGE_URL)).toMatchObject({ canTrust: false })
    expect(approvalPromptForCall(call('browser_forward'), 'auto', PAGE_URL)).toMatchObject({ canTrust: false })
  })

  it('renders approval summaries', () => {
    expect(approvalPromptForCall(call('browser_type', {
      index: 3,
      text: 'secret',
    }), 'auto', PAGE_URL)?.summary).toBe(
      'Enter 6 characters in element [3] (the text is not shown in this dialog)',
    )
    expect(approvalPromptForCall(call('browser_snapshot'), 'ask', PAGE_URL)?.summary)
      .toBe('Read the current page')
  })
})

describe('originFromUrl', () => {
  it('accepts web/blob origins and rejects browser-internal or invalid URLs', () => {
    expect(originFromUrl('https://example.com/path?q=1')).toBe('https://example.com')
    expect(originFromUrl('blob:https://example.com/id')).toBe('https://example.com')
    expect(originFromUrl('chrome://settings')).toBeUndefined()
    expect(originFromUrl('not a url')).toBeUndefined()
  })
})
