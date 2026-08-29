import { describe, expect, it } from 'vitest'
import { entitiesToTags, extractEntities } from '../src/entity-extract.ts'

describe('extractEntities', () => {
  it('extracts hashtags, mentions, and urls from free text', () => {
    const text = 'Loving this #sunset shot by @jane_doe — see more at https://example.com/gallery'
    const entities = extractEntities(text)
    expect(entities.hashtags).toEqual(['sunset'])
    expect(entities.mentions).toEqual(['jane_doe'])
    expect(entities.urls).toEqual(['https://example.com/gallery'])
  })

  it('returns empty arrays for undefined or entity-free text', () => {
    expect(extractEntities(undefined)).toEqual({ hashtags: [], mentions: [], urls: [] })
    expect(extractEntities('just plain text')).toEqual({ hashtags: [], mentions: [], urls: [] })
  })

  it('de-duplicates case-insensitively, keeping first-seen casing', () => {
    const entities = extractEntities('#Travel is fun. #travel again. #TRAVEL once more.')
    expect(entities.hashtags).toEqual(['Travel'])
  })

  it('supports unicode letters in hashtags', () => {
    expect(extractEntities('#café life').hashtags).toEqual(['café'])
  })
})

describe('entitiesToTags', () => {
  it('prefixes hashtags with # and mentions with @, lowercased', () => {
    const tags = entitiesToTags({ hashtags: ['Sunset'], mentions: ['Jane_Doe'], urls: [] })
    expect(tags).toEqual(['#sunset', '@jane_doe'])
  })

  it('caps the number of tags returned', () => {
    const hashtags = Array.from({ length: 20 }, (_, i) => `tag${i}`)
    const tags = entitiesToTags({ hashtags, mentions: [], urls: [] }, 5)
    expect(tags).toHaveLength(5)
  })
})
