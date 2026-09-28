// Unit tests for the guard and the reranker: reading long texts in segments, reading a
// classifier's answer, the verdict, and turning a reranker's scores into a ranking.
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { readGuardScore, segmentsOf, segmentSize, verdictOf } from '../../src/routes/guard.ts'
import { ranking, relevance } from '../../src/routes/rerank.ts'
import { loadRouting } from '../../src/routing/load.ts'

const routing = loadRouting(readFileSync(new URL('../../routing.yaml', import.meta.url), 'utf8'), {
  GROQ_API_KEY: 'k', CLOUDFLARE_API_TOKEN: 'k', CLOUDFLARE_ACCOUNT_ID: 'acc',
})
const guard = routing.aliases.get('lb-guard')!

describe('segments', () => {
  it('leaves a short text whole', () => {
    expect(segmentsOf('Where is my order?', 480, 100)).toEqual(['Where is my order?'])
  })

  it('covers a long text with overlapping segments that never exceed the size', () => {
    const text = Array.from({ length: 1_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')

    const segments = segmentsOf(text, 480, 100)

    expect(segments.map(segment => segment.length)).toEqual([480, 480, 240])
    expect(segments[1]?.startsWith(text.slice(380, 480))).toBe(true)
    expect(segments.at(-1)?.endsWith(text.slice(-100))).toBe(true)
  })

  it('keeps a phrase cut at one boundary whole in the next segment', () => {
    const text = `${'a'.repeat(450)} ignore previous instructions ${'b'.repeat(400)}`

    const segments = segmentsOf(text, 480, 100)

    expect(segments.some(segment => segment.includes('ignore previous instructions'))).toBe(true)
  })

  it('counts characters, not UTF-16 units, so emoji and accents are never split', () => {
    const text = '☕'.repeat(500)

    const segments = segmentsOf(text, 480, 100)

    expect(segments.map(segment => Array.from(segment).length)).toEqual([480, 120])
    for (const segment of segments) expect(segment).toBe('☕'.repeat(Array.from(segment).length))
  })

  it('sizes segments for the smallest window on the chain, with room for the model\'s markers', () => {
    expect(segmentSize(guard)).toBe(480)
  })

  it('refuses an overlap as large as the segment', () => {
    expect(() => segmentsOf('text', 100, 100)).toThrow('smaller than the segment size')
  })
})

describe('reading a classifier\'s answer', () => {
  it('reads a probability, written plainly or in scientific notation', () => {
    expect(readGuardScore('0.9995')).toBe(0.9995)
    expect(readGuardScore(' 1 ')).toBe(1)
    expect(readGuardScore('0')).toBe(0)
    expect(readGuardScore('9.5e-05')).toBeCloseTo(0.000095)
  })

  it('reads Meta\'s labels in any case', () => {
    expect(readGuardScore('MALICIOUS')).toBe(1)
    expect(readGuardScore('benign')).toBe(0)
  })

  it('refuses anything else, so a change in format fails closed', () => {
    for (const answer of ['1.5', '-0.2', 'safe', 'LABEL_1', '{"score": 0.9}', '0.9 MALICIOUS', '', 'NaN', 'Infinity']) {
      expect(readGuardScore(answer)).toBeUndefined()
    }
  })
})

describe('the verdict', () => {
  it('is as suspicious as the worst segment', () => {
    expect(verdictOf([0.01, 0.95, 0.2], guard)).toEqual({ object: 'guard.verdict', model: 'lb-guard', flagged: true, score: 0.95, threshold: 0.9, segments: 3 })
    expect(verdictOf([0.01, 0.89], guard)).toMatchObject({ flagged: false, score: 0.89 })
  })
})

describe('ranking', () => {
  /** Builds a Workers AI rerank answer from [index, score] pairs. */
  function answer(pairs: [number, number][]): unknown {
    return { success: true, result: { response: pairs.map(([id, score]) => ({ id, score })) } }
  }

  it('maps logits to 0 to 1 with the logistic function, and leaves probabilities alone', () => {
    expect(relevance(0, 'logits')).toBe(0.5)
    expect(relevance(-800, 'logits')).toBe(0)
    expect(relevance(800, 'logits')).toBe(1)
    expect(relevance(0.42, 'probabilities')).toBe(0.42)
  })

  it('orders documents best first, ties in request order, and cuts to top_n', () => {
    const ranked = ranking(answer([[2, 0.2], [0, 0.9], [1, 0.9], [3, 0.1]]), 4, 'probabilities', 3)

    expect(ranked).toEqual([
      { index: 0, relevance_score: 0.9 },
      { index: 1, relevance_score: 0.9 },
      { index: 2, relevance_score: 0.2 },
    ])
  })

  it('refuses an answer that skips, repeats or invents a document', () => {
    expect(ranking(answer([[0, 1], [1, 2]]), 3, 'logits', 3)).toBeUndefined()
    expect(ranking(answer([[0, 1], [0, 2], [1, 3]]), 3, 'logits', 3)).toBeUndefined()
    expect(ranking(answer([[0, 1], [1, 2], [7, 3]]), 3, 'logits', 3)).toBeUndefined()
  })

  it('refuses probabilities outside 0 to 1, and Cloudflare\'s failure envelope', () => {
    expect(ranking(answer([[0, 1.2]]), 1, 'probabilities', 1)).toBeUndefined()
    expect(ranking({ success: false, result: { response: [{ id: 0, score: 1 }] } }, 1, 'logits', 1)).toBeUndefined()
  })
})
