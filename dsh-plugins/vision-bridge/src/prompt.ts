/**
 * Builds the text prompt sent alongside the image. The structured,
 * coordinate-annotated format is the one clear quality win
 * dsh-plugin-mm-vision had over visionDS's plain "describe this image"
 * prompt (see the mm-vision review in `docs/adr/rp_dshPlugins.md`) — it
 * gives a text-only model something a lot more useful than prose to reason
 * about layout, charts, and UI screenshots with.
 * @module dsh-plugin-vision-bridge/prompt
 */

export type PromptMode = 'auto' | 'chart' | 'photo'

const BASE_PROMPT = `Describe this image as compact, structured text so a reader with no
access to the image can reconstruct its layout and content. Use this format:

1. Canvas: aspect ratio, dominant background color/tone.
2. Elements: one line each — [type | position x%,y% (origin top-left) | size w%xh% | color | key text/value].
3. Relationships: spatially meaningful relations between elements (above/below, left/right, overlapping, contained-in) — only ones worth stating.
4. Uncertain items: mark as [uncertain]; never invent detail that isn't visible.

Coordinates to the nearest 1%. Keep the whole answer under 500 words.`

const CHART_TAIL = `\n\nThis looks like a chart, dashboard, or UI screenshot: prioritize axis
ranges, each notable point (peak/trough/crossing) with its (x%,y%) and
value, curve shape (rising/falling/flat), and label positions.`

const PHOTO_TAIL = `\n\nThis looks like a natural photo: prioritize the main subject (position,
features), foreground/background separation, light direction, and
composition.`

const CHART_HINT = /chart|dashboard|graph|plot|kline|candle|screenshot|ui\b|dial|gauge|axis/i

/** Auto-detect chart-vs-photo emphasis from the user's own request text, falling back to a neutral prompt. */
export function resolveMode(mode: PromptMode, userText: string): PromptMode {
  if (mode !== 'auto') return mode
  return CHART_HINT.test(userText) ? 'chart' : 'auto'
}

/** Assemble the full prompt sent to the vision provider. */
export function buildPrompt(userText: string, mode: PromptMode): string {
  const tail = mode === 'chart' ? CHART_TAIL : mode === 'photo' ? PHOTO_TAIL : ''
  const extra = userText.trim().length > 0 ? `\n\nAdditional user request: ${userText.trim()}` : ''
  return `${BASE_PROMPT}${tail}${extra}`
}
