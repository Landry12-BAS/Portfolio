// Tests of one service's chart (ServiceChart.vue), on the numbers of a real incident from the mock
// back end's simulator: the letters that name the incident's landmarks are spread over rows so that
// landmarks a few minutes apart (the fault, the alert and the agents' start are all within three
// minutes) do not print on top of one another, a letter by the right edge turns to the left of its
// line so it is not cut off, and the chart still has its text alternative and one line a landmark.
import { describe, expect, it } from 'vitest'
import ServiceChart from '~/boards/lb-06/components/ServiceChart.vue'
import { markersOf } from '~/boards/lb-06/incident'
import { ticksOf } from '~/boards/lb-06/series'
import { mountWithSite } from '../support/mount'
import { playIncident } from '../support/lb06-incident'

/** The drawing's width and the room the chart leaves at its right edge, as ServiceChart.vue sets them. */
const DRAWING_WIDTH = 260
/** The top row of letters: the plot's top (10) and a line's height (8). */
const TOP_ROW = 18

/** Draws the cart's error rate for a played incident and reads the lines and letters it drew. */
async function drawn() {
  const { events } = await playIncident()
  const wrapper = mountWithSite(ServiceChart, { props: { service: 'cart', metric: 'error_rate', ticks: ticksOf(events), markers: markersOf(events) } })
  const lines = wrapper.findAll('line.marker').map(line => Number(line.attributes('x1')))
  const letters = wrapper.findAll('text.letter').map(text => ({
    text: text.text(),
    x: Number(text.attributes('x')),
    y: Number(text.attributes('y')),
    anchor: text.attributes('text-anchor'),
  }))
  return { wrapper, lines, letters }
}

describe('a service\'s chart', () => {
  it('draws one dashed line and one letter for every landmark of the incident', async () => {
    const { lines, letters } = await drawn()
    expect(lines.length).toBeGreaterThanOrEqual(4)
    expect(letters.map(letter => letter.text).slice(0, 3)).toEqual(['F', 'A', 'I'])
    expect(letters).toHaveLength(lines.length)
  })

  it('puts the letter of a landmark that is close to the one before it on a row of its own', async () => {
    const { lines, letters } = await drawn()
    let close = 0
    for (let index = 1; index < letters.length; index += 1) {
      const previousLine = lines[index - 1] ?? 0
      const line = lines[index] ?? 0
      if (line - previousLine < 14) {
        close += 1
        expect(letters[index]?.y, `the letter ${letters[index]?.text} is on the row of the letter before it`).not.toBe(letters[index - 1]?.y)
      }
    }
    expect(close, 'the fault, the alert and the start of the investigation are close together').toBeGreaterThanOrEqual(2)
  })

  it('puts a landmark far from the one before it back on the top row', async () => {
    const { lines, letters } = await drawn()
    const far = letters.findIndex((_, index) => index > 0 && (lines[index] ?? 0) - (lines[index - 1] ?? 0) >= 14)
    expect(far).toBeGreaterThan(0)
    expect(letters[far]?.y).toBe(TOP_ROW)
  })

  it('turns the letter of a landmark by the right edge to the left of its line, so it stays inside the drawing', async () => {
    const { lines, letters } = await drawn()
    const last = letters.at(-1)
    const lastLine = lines.at(-1) ?? 0
    expect(last?.text).toBe('OK')
    expect(last?.anchor).toBe('end')
    expect(last?.x).toBeLessThan(lastLine)
    for (const letter of letters) {
      if (letter.anchor === 'end') expect(letter.x).toBeLessThanOrEqual(DRAWING_WIDTH)
      else expect(letter.x + letter.text.length * 6, `the letter ${letter.text} fits in the drawing`).toBeLessThanOrEqual(DRAWING_WIDTH)
    }
  })

  it('keeps its text alternative, which gives the start, the peak and the present value', async () => {
    const { wrapper } = await drawn()
    expect(wrapper.get('desc').text()).toMatch(/^Cart, Error rate\. It started at [\d.,]+ %, peaked at [\d.,]+ % in minute \d+, and was at [\d.,]+ % in minute \d+\.$/)
    expect(wrapper.get('svg[role="img"]').attributes('aria-labelledby')).toContain(wrapper.get('title').attributes('id'))
  })
})
