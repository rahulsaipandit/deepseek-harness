import { describe, expect, it } from 'vitest'
import { buildBookmarkletHref, buildCaptureScript, renderInstallPage } from '../src/bookmarklet.ts'

describe('buildCaptureScript', () => {
  it('embeds the platform, endpoint, and token as JSON-safe literals', () => {
    const script = buildCaptureScript('instagram', 'http://127.0.0.1:1234/social-capture/capture', 'my"token')
    expect(script).toContain('"instagram"')
    expect(script).toContain('"http://127.0.0.1:1234/social-capture/capture"')
    // JSON.stringify escapes the embedded quote, so the raw token text never breaks out of the string literal.
    expect(script).toContain('my\\"token')
  })

  it('reads og: meta tags rather than platform-specific private DOM structures', () => {
    const script = buildCaptureScript('instagram', 'http://x/capture', 'token')
    expect(script).toContain('og:title')
    expect(script).toContain('og:description')
    expect(script).toContain('og:url')
  })
})

describe('buildBookmarkletHref', () => {
  it('produces a javascript: URI wrapping the encoded script', () => {
    const href = buildBookmarkletHref('instagram', 'http://x/capture', 'token')
    expect(href.startsWith('javascript:')).toBe(true)
    const decoded = decodeURIComponent(href.slice('javascript:'.length))
    expect(decoded).toBe(buildCaptureScript('instagram', 'http://x/capture', 'token'))
  })
})

describe('renderInstallPage', () => {
  it('renders one section per configured platform with a bookmarklet link', () => {
    const html = renderInstallPage({ captureEndpoint: 'http://x/capture', platforms: ['instagram'], token: 'tok' })
    expect(html).toContain('<h2>instagram</h2>')
    expect(html).toContain('javascript:')
  })

  it('escapes HTML-significant characters in platform names', () => {
    const html = renderInstallPage({ captureEndpoint: 'http://x/capture', platforms: ['<script>'], token: 'tok' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
