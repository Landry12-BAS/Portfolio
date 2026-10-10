// Tests of how the board orders and filters a report's findings, and of the risk radar's geometry: the
// most serious finding first, a risk before a missing clause, the contract's own order among equals, a
// radar whose nine axes are the report's scores and nothing else, and labels that sit on the side of the
// radar they belong to. Both are pure functions of the report, so what the page draws can be checked
// without a page.
import type { Lb04Finding, Lb04RadarScore } from '@lb/contracts'
import { LB04_TOPICS } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { citationOf, countBySeverity, filterFindings, findingById, sortFindings } from '~/boards/lb-04/findings'
import { buildRadar, MAX_SCORE, RADAR_HEIGHT, RADAR_WIDTH } from '~/boards/lb-04/radar'

import cs from '../../i18n/locales/cs'
import en from '../../i18n/locales/en'

/** Makes a risk finding. */
function risk(id: string, topic: Lb04Finding['topic'], severity: Lb04Finding['severity'], page: number, start: number): Lb04Finding {
  return { id, kind: 'risk', topic, rule: 'payment-slow', title: `Finding ${id}`, severity, summary: 'A sentence.', source: 'model', clause: null, citation: { page, start, end: start + 20 }, quote: 'x'.repeat(20) }
}

/** Makes a finding about a clause that is missing. */
function absent(id: string, topic: Lb04Finding['topic'], severity: Lb04Finding['severity']): Lb04Finding {
  return { id, kind: 'absent', topic, rule: 'indemnity-present', title: `Finding ${id}`, severity, summary: 'A sentence.', source: 'detector', searched: ['indemnify'] }
}

const FINDINGS: Lb04Finding[] = [
  absent('f1', 'indemnity', 'medium'),
  risk('f2', 'payment', 'medium', 5, 100),
  risk('f3', 'liability', 'critical', 21, 40),
  risk('f4', 'payment', 'medium', 2, 900),
  risk('f5', 'renewal', 'high', 3, 10),
  risk('f6', 'ip', 'high', 3, 10),
]

describe('the order of findings', () => {
  it('is the most serious first, then risks before missing clauses, then the contract\'s own order, then by ID', () => {
    expect(sortFindings(FINDINGS).map(finding => finding.id)).toEqual(['f3', 'f5', 'f6', 'f4', 'f2', 'f1'])
  })

  it('leaves the list it was given alone', () => {
    const before = FINDINGS.map(finding => finding.id)
    sortFindings(FINDINGS)

    expect(FINDINGS.map(finding => finding.id)).toEqual(before)
  })

  it('numbers IDs as numbers, so f10 follows f9', () => {
    const many = [risk('f10', 'ip', 'low', 1, 0), risk('f9', 'ip', 'low', 1, 0), risk('f2', 'ip', 'low', 1, 0)]

    expect(sortFindings(many).map(finding => finding.id)).toEqual(['f2', 'f9', 'f10'])
  })
})

describe('narrowing the findings', () => {
  it('keeps one topic, one severity, both, or everything', () => {
    expect(filterFindings(FINDINGS, { topic: 'payment' }).map(finding => finding.id)).toEqual(['f2', 'f4'])
    expect(filterFindings(FINDINGS, { severity: 'high' }).map(finding => finding.id)).toEqual(['f5', 'f6'])
    expect(filterFindings(FINDINGS, { topic: 'payment', severity: 'high' })).toEqual([])
    expect(filterFindings(FINDINGS, {})).toHaveLength(6)
  })

  it('counts by severity from critical down, with a zero where there is none', () => {
    expect(countBySeverity(FINDINGS)).toEqual([{ severity: 'critical', count: 1 }, { severity: 'high', count: 2 }, { severity: 'medium', count: 3 }, { severity: 'low', count: 0 }])
  })

  it('finds a finding by its ID, and a citation only on a risk', () => {
    expect(findingById(FINDINGS, 'f3')?.title).toBe('Finding f3')
    expect(findingById(FINDINGS, 'f99')).toBeUndefined()
    expect(findingById(FINDINGS, undefined)).toBeUndefined()
    expect(citationOf(FINDINGS[0] as Lb04Finding)).toBeUndefined()
    expect(citationOf(FINDINGS[1] as Lb04Finding)).toEqual({ page: 5, start: 100, end: 120 })
  })
})

/** The scores of a report that found something in three topics. */
function scores(): Lb04RadarScore[] {
  const worst: Partial<Record<(typeof LB04_TOPICS)[number], number>> = { liability: 4, renewal: 3, payment: 2 }
  return LB04_TOPICS.map(topic => ({ topic, score: worst[topic] ?? 0, findings: worst[topic] === undefined ? 0 : 1 }))
}

describe('the risk radar', () => {
  it('has an axis for each topic, in the report\'s order, starting at the top and going clockwise', () => {
    const shape = buildRadar(scores())

    expect(shape.axes.map(axis => axis.topic)).toEqual([...LB04_TOPICS])
    expect(shape.axes[0]?.tip).toEqual({ x: shape.centre.x, y: shape.centre.y - shape.radius })
    const second = shape.axes[1]
    expect(second && second.tip.x > shape.centre.x && second.tip.y < shape.centre.y).toBe(true)
    expect([shape.width, shape.height]).toEqual([RADAR_WIDTH, RADAR_HEIGHT])
  })

  it('puts a point on each axis in proportion to its score: the rim for critical, the centre for none', () => {
    const shape = buildRadar(scores())
    const liability = shape.axes[0]
    const indemnity = shape.axes[1]

    expect(liability?.point).toEqual(liability?.tip)
    expect(indemnity?.point).toEqual(shape.centre)
    const renewal = shape.axes.find(axis => axis.topic === 'renewal')
    const distance = Math.hypot((renewal?.point.x ?? 0) - shape.centre.x, (renewal?.point.y ?? 0) - shape.centre.y)
    expect(distance).toBeCloseTo(shape.radius * 3 / MAX_SCORE, 0)
  })

  it('has a ring for each severity, each with a corner on every axis, and one polygon through the points', () => {
    const shape = buildRadar(scores())

    expect(shape.rings.map(ring => ring.score)).toEqual([1, 2, 3, 4])
    for (const ring of shape.rings) expect(ring.points.split(' ')).toHaveLength(9)
    expect(shape.polygon.split(' ')).toHaveLength(9)
    expect(shape.rings[3]?.points.split(' ')[0]).toBe(`${shape.axes[0]?.tip.x},${shape.axes[0]?.tip.y}`)
  })

  it('anchors a label by the side of the radar its axis is on: the top and bottom centred, the right starting, the left ending', () => {
    const anchors = buildRadar(scores()).axes.map(axis => axis.label.anchor)

    expect(anchors[0]).toBe('middle')
    expect(anchors[1]).toBe('start')
    expect(anchors[8]).toBe('end')
    expect(anchors.filter(anchor => anchor === 'start')).toHaveLength(4)
  })

  it('leaves each label the room its text needs to the edge of the drawing, in English and in Czech', () => {
    const shape = buildRadar(scores())
    // A topic's name at 14 units in the semibold face is about 7.4 units a character; a little more is allowed.
    const characterWidth = 8.2
    for (const messages of [en, cs]) {
      for (const axis of shape.axes) {
        const needed = messages.lb04.topics[axis.topic].length * characterWidth
        const room = axis.label.anchor === 'end'
          ? axis.label.x
          : axis.label.anchor === 'start'
            ? shape.width - axis.label.x
            : Math.min(axis.label.x, shape.width - axis.label.x) * 2
        expect(room, `${axis.topic} in ${messages.lb04.topics[axis.topic]}`).toBeGreaterThanOrEqual(needed)
        expect(axis.label.y).toBeGreaterThan(8)
        expect(axis.label.y).toBeLessThan(shape.height - 8)
      }
    }
  })

  it('makes the same drawing for the same report, and one with all zeros collapses to the centre', () => {
    expect(buildRadar(scores())).toEqual(buildRadar(scores()))
    const empty = buildRadar(LB04_TOPICS.map(topic => ({ topic, score: 0, findings: 0 })))

    expect(new Set(empty.polygon.split(' ')).size).toBe(1)
  })
})
