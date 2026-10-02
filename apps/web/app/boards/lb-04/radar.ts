// The geometry of the risk radar: nine axes, one for each topic of the playbook, drawn clockwise from
// the top, with a ring for each severity (1 for low up to 4 for critical) and a polygon through the
// topic's worst verified finding. The radar is made from the report's own scores and nothing else, so
// what it draws is what the table beside it says. Plain numbers in, plain numbers out: the component
// only turns them into SVG.
import type { Lb04RadarScore, Lb04Topic } from '@lb/contracts'

/** The width and the height of the rectangle the radar is drawn in, in SVG units: wider than tall, since the labels run sideways. */
export const RADAR_WIDTH = 560
export const RADAR_HEIGHT = 440
/** The room left at each side of the rings, and above and below them, for the axes' labels. */
const SIDE_MARGIN = 132
const VERTICAL_MARGIN = 58
/** The highest score: a critical finding. */
export const MAX_SCORE = 4
/** How far beyond the outer ring a label starts. */
const LABEL_GAP = 16

/** A point of the radar. */
export interface Point {
  x: number
  y: number
}

/** Where the text of a label starts from its point: the left half of the radar ends its labels there, the right half starts them, and the top and bottom centre them. */
export type Anchor = 'start' | 'middle' | 'end'

/** One axis of the radar: a topic, its score and where its parts are drawn. */
export interface RadarAxis {
  topic: Lb04Topic
  score: number
  findings: number
  // From the centre to the outer ring.
  tip: Point
  // The topic's score on the axis.
  point: Point
  label: Point & { anchor: Anchor }
}

/** The whole radar. */
export interface RadarShape {
  width: number
  height: number
  centre: Point
  radius: number
  // One polygon for each score from 1 to 4, as the `points` of an SVG polygon.
  rings: { score: number, points: string }[]
  axes: RadarAxis[]
  // The polygon through the scores, as the `points` of an SVG polygon.
  polygon: string
}

/** Rounds to one decimal, so the same report always makes the same drawing. */
function round(value: number): number {
  return Math.round(value * 10) / 10
}

/** The point at `fraction` of the way from the centre to the rim along the axis at `angle` (radians, 0 pointing to the top, growing clockwise). */
function along(centre: Point, radius: number, angle: number, fraction: number): Point {
  return { x: round(centre.x + radius * fraction * Math.sin(angle)), y: round(centre.y - radius * fraction * Math.cos(angle)) }
}

/** Chooses where a label's text starts from its point by which side of the radar it is on. */
function anchorOf(angle: number): Anchor {
  const sideways = Math.sin(angle)
  if (Math.abs(sideways) < 0.25) return 'middle'
  return sideways > 0 ? 'start' : 'end'
}

/** Writes points as the `points` of an SVG polygon. */
function polygonOf(points: readonly Point[]): string {
  return points.map(point => `${point.x},${point.y}`).join(' ')
}

/** Builds the radar of a report's scores, in the order the report gives them, which is the playbook's. */
export function buildRadar(scores: readonly Lb04RadarScore[], width: number = RADAR_WIDTH, height: number = RADAR_HEIGHT): RadarShape {
  const centre = { x: width / 2, y: height / 2 }
  const radius = Math.min(width / 2 - SIDE_MARGIN, height / 2 - VERTICAL_MARGIN)
  const count = Math.max(scores.length, 1)
  const angleOf = (index: number): number => (2 * Math.PI * index) / count
  const axes = scores.map((entry, index): RadarAxis => {
    const angle = angleOf(index)
    const label = along(centre, radius + LABEL_GAP, angle, 1)
    return {
      topic: entry.topic,
      score: entry.score,
      findings: entry.findings,
      tip: along(centre, radius, angle, 1),
      point: along(centre, radius, angle, entry.score / MAX_SCORE),
      label: { ...label, anchor: anchorOf(angle) },
    }
  })
  const rings = Array.from({ length: MAX_SCORE }, (_, step) => {
    const score = step + 1
    return { score, points: polygonOf(scores.map((_, index) => along(centre, radius, angleOf(index), score / MAX_SCORE))) }
  })
  return { width, height, centre, radius, rings, axes, polygon: polygonOf(axes.map(axis => axis.point)) }
}
