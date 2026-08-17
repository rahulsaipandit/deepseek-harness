import { describe, expect, it } from 'vitest'
import { buildPrompt, resolveMode } from '../src/prompt.ts'

describe('resolveMode', () => {
  it('passes through an explicit mode unchanged', () => {
    expect(resolveMode('photo', 'this looks like a chart')).toBe('photo')
    expect(resolveMode('chart', 'a plain photo')).toBe('chart')
  })

  it('detects chart-ish requests in auto mode', () => {
    expect(resolveMode('auto', 'what does this dashboard screenshot show?')).toBe('chart')
    expect(resolveMode('auto', 'read the kline chart')).toBe('chart')
  })

  it('falls back to neutral auto mode when nothing hints at a chart', () => {
    expect(resolveMode('auto', 'what is in this photo?')).toBe('auto')
    expect(resolveMode('auto', '')).toBe('auto')
  })
})

describe('buildPrompt', () => {
  it('always includes the structured coordinate-format instructions', () => {
    expect(buildPrompt('', 'auto')).toMatch(/x%,y%/)
  })

  it('appends the chart-specific tail only in chart mode', () => {
    expect(buildPrompt('', 'chart')).toMatch(/axis\s+ranges/)
    expect(buildPrompt('', 'photo')).not.toMatch(/axis\s+ranges/)
  })

  it('appends the photo-specific tail only in photo mode', () => {
    expect(buildPrompt('', 'photo')).toMatch(/composition/)
    expect(buildPrompt('', 'chart')).not.toMatch(/composition/)
  })

  it('folds in the user text as an additional request', () => {
    expect(buildPrompt('focus on the top-left button', 'auto')).toMatch(/focus on the top-left button/)
  })
})
