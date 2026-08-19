/**
 * Cheap, LLM-free contradiction detection: eight fixed negation-pattern
 * pairs, adapted from cognitiveBrain's `ConflictDetector.ts`
 * (`core/autonomous/ConflictDetector.ts`) with its `entities[]`-based
 * grouping dropped — this design has no entity-extraction step to feed it.
 * See designCognitiveBrainForDSH.md §5.6: the pattern check is meant to run
 * only against a candidate note already narrowed by embedding similarity +
 * shared tag (`memory_related`'s own mechanism), not against the whole
 * vault — the two signals are complementary, neither alone as strong as
 * both together.
 * @module dsh-plugin-knowledge-hub/contradiction
 */

interface NegationPatternPair {
  label: string
  positive: RegExp
  negative: RegExp
}

const NEGATION_PATTERNS: NegationPatternPair[] = [
  { label: 'is / is not', positive: /\bis\b/i, negative: /\bis not\b|\bisn't\b/i },
  { label: 'can / cannot', positive: /\bcan\b/i, negative: /\bcannot\b|\bcan't\b/i },
  { label: 'will / will not', positive: /\bwill\b/i, negative: /\bwill not\b|\bwon't\b/i },
  { label: 'always / never', positive: /\balways\b/i, negative: /\bnever\b/i },
  { label: 'enabled / disabled', positive: /\benabled\b/i, negative: /\bdisabled\b/i },
  { label: 'active / inactive', positive: /\bactive\b/i, negative: /\binactive\b/i },
  { label: 'succeeded / failed', positive: /\bsucceeded\b/i, negative: /\bfailed\b/i },
  { label: 'approved / rejected', positive: /\bapproved\b/i, negative: /\brejected\b/i },
]

/**
 * Check whether two notes' content assert opposite sides of any of the
 * eight fixed pattern pairs. Returns a human-readable reason on a hit, or
 * `undefined` — never throws, never infers anything beyond a literal
 * pattern match (no NLP, no entity model).
 */
export function findContradiction(a: string, b: string): string | undefined {
  for (const { label, positive, negative } of NEGATION_PATTERNS) {
    const aPos = positive.test(a) && !negative.test(a)
    const bPos = positive.test(b) && !negative.test(b)
    const aNeg = negative.test(a)
    const bNeg = negative.test(b)
    if ((aPos && bNeg) || (aNeg && bPos)) {
      return `one note matches "${label.split(' / ')[0]}" phrasing while the other matches "${label.split(' / ')[1]}" phrasing`
    }
  }
  return undefined
}
