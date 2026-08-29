/**
 * Generates the per-platform browser capture script and the install page
 * that serves it — the actual "Siftly pattern" this plugin borrows: a
 * script the user runs inside their own already-authenticated browser tab,
 * which reads the page's own DOM/meta tags and POSTs the result to this
 * plugin's receiver. Nothing here ever touches a login form, a password,
 * or a session cookie — the harness never authenticates as the user on the
 * social platform; the user's own browser session does the reading.
 *
 * Two delivery forms, same script, matching Siftly's own
 * bookmarklet-or-console-script duality: a draggable `javascript:` link
 * (bookmarklet) and the raw source for pasting into DevTools directly.
 * @module dsh-plugin-social-capture/bookmarklet
 */

export type CapturePlatform = 'instagram' | 'generic'

/**
 * The captured page reads its own Open Graph meta tags — the same
 * `og:title`/`og:description`/`og:image`/`og:url` fields most social
 * platforms (including Instagram's post pages) already populate for link
 * previews — rather than depending on any specific platform's internal DOM
 * structure or private data blobs, which change without notice and are far
 * more likely to break the capture silently.
 */
function captureScriptSource(platform: CapturePlatform, endpoint: string, token: string): string {
  return `(function () {
  function meta(name) {
    var el = document.querySelector('meta[property="' + name + '"]') || document.querySelector('meta[name="' + name + '"]')
    return el ? el.getAttribute('content') : undefined
  }
  var payload = {
    platform: ${JSON.stringify(platform)},
    url: meta('og:url') || location.href,
    capturedAt: new Date().toISOString(),
    author: meta('og:title'),
    text: meta('og:description'),
    mediaUrls: [meta('og:image'), meta('og:video')].filter(Boolean),
  }
  fetch(${JSON.stringify(endpoint)}, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-capture-token': ${JSON.stringify(token)} },
    body: JSON.stringify(payload),
  })
    .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status)) })
    .then(function () { alert('Saved to your knowledge base.') })
    .catch(function (err) { alert('Capture failed: ' + err.message) })
})()`
}

/** The raw script, for the "paste into DevTools console" delivery form. */
export function buildCaptureScript(platform: CapturePlatform, endpoint: string, token: string): string {
  return captureScriptSource(platform, endpoint, token)
}

/** The same script wrapped as a `javascript:` URI, for a draggable bookmarklet link. */
export function buildBookmarkletHref(platform: CapturePlatform, endpoint: string, token: string): string {
  return `javascript:${encodeURIComponent(captureScriptSource(platform, endpoint, token))}`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

export interface InstallPageOptions {
  captureEndpoint: string
  platforms: CapturePlatform[]
  token: string
}

/**
 * Render the install page: one draggable bookmarklet link plus the raw
 * script per configured platform. Served over the loopback web server —
 * never intended to be reached by anything but the person configuring
 * their own browser.
 */
export function renderInstallPage(options: InstallPageOptions): string {
  const sections = options.platforms.map((platform) => {
    const href = buildBookmarkletHref(platform, options.captureEndpoint, options.token)
    const script = buildCaptureScript(platform, options.captureEndpoint, options.token)
    return `
    <section>
      <h2>${escapeHtml(platform)}</h2>
      <p>
        Drag this link to your bookmarks bar, then click it while viewing a
        ${escapeHtml(platform)} post you're logged into:
      </p>
      <p><a href="${href}" onclick="return false;" style="font-weight:bold;">📌 Capture this ${escapeHtml(platform)} post</a></p>
      <p>Or paste this into your browser's DevTools console on the post page:</p>
      <pre style="white-space:pre-wrap;background:#111;color:#eee;padding:0.75rem;border-radius:4px;">${escapeHtml(script)}</pre>
    </section>`
  }).join('\n')

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>social-capture install</title>
</head>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;">
<h1>social-capture</h1>
<p>
  These tools run entirely inside your own logged-in browser tab. They only
  read the current page and send the result to this DSH instance — no
  password, session cookie, or login flow is ever handled by the harness.
</p>
${sections}
</body>
</html>`
}
