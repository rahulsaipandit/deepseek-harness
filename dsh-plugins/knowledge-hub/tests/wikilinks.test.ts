import { describe, expect, it } from 'vitest'
import { buildTitleIndex, extractWikilinks, resolveWikilinks } from '../src/wikilinks.ts'

describe('extractWikilinks', () => {
  it('extracts plain [[Target]] links', () => {
    expect(extractWikilinks('See [[React Hooks]] and [[Deployment Pipeline]] for more.')).toEqual([
      'React Hooks',
      'Deployment Pipeline',
    ])
  })

  it('drops alias (|) and heading-anchor (#) suffixes', () => {
    expect(extractWikilinks('[[React Hooks|hooks]] and [[Deployment Pipeline#Rollback]]')).toEqual([
      'React Hooks',
      'Deployment Pipeline',
    ])
  })

  it('returns [] when there are no wikilinks', () => {
    expect(extractWikilinks('Just plain text.')).toEqual([])
  })
})

describe('resolveWikilinks / buildTitleIndex', () => {
  it('resolves case-insensitively and drops unresolvable targets', () => {
    const index = buildTitleIndex([
      { id: 'a', title: 'React Hooks' },
      { id: 'b', title: 'Deployment Pipeline' },
    ])
    const resolved = resolveWikilinks(['react hooks', 'Nonexistent Page', 'Deployment Pipeline'], index)
    expect(resolved).toEqual(['a', 'b'])
  })
})
