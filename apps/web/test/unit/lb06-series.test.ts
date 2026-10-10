// Tests of the numbers behind LB-06's dashboards (app/boards/lb-06/series.ts): the scale a chart's axis
// takes, where a point lands, the line a series draws, the facts its text alternative states, and the
// one-word health of each service, checked against the real simulator: every service is normal in the
// calm before a fault, and the service each fault strikes is not normal once the agents have a proposal.
import { LB06_FAULTS } from '@lb/contracts'
import type { Lb06Fault, Lb06Service } from '@lb/contracts'
import { describe, expect, it } from 'vitest'
import { AXIS_FLOOR, domainOf, factsOf, healthOf, MIN_SPAN_MINUTES, niceCeiling, pathOf, SERVICES, seriesOf, ticksOf, xOf, yOf } from '~/boards/lb-06/series'
import type { Frame, Point } from '~/boards/lb-06/series'
import { playIncident } from '../support/lb06-incident'

/** The service each fault strikes first (services/node-systems/src/modules/lb06/sim/faults.ts). */
const STRUCK: Readonly<Record<Lb06Fault, Lb06Service>> = {
  bad_deploy: 'cart',
  slow_payment: 'payment',
  memory_leak: 'inventory',
  cache_stampede: 'cache',
}

const FRAME: Frame = { width: 200, height: 100, left: 20, right: 0, top: 10, bottom: 10 }

describe('the top of an axis', () => {
  it('rounds up to the next 1, 2, 5 or 10 times a power of ten', () => {
    expect(niceCeiling(0.03)).toBe(0.05)
    expect(niceCeiling(1)).toBe(1)
    expect(niceCeiling(1.2)).toBe(2)
    expect(niceCeiling(2.5)).toBe(5)
    expect(niceCeiling(7)).toBe(10)
    expect(niceCeiling(480)).toBe(500)
    expect(niceCeiling(4602)).toBe(5000)
  })

  it('is 1 for anything that is not a positive number', () => {
    expect(niceCeiling(0)).toBe(1)
    expect(niceCeiling(-4)).toBe(1)
    expect(niceCeiling(Number.NaN)).toBe(1)
  })
})

describe('the domain of a series', () => {
  it('spans at least a stretch of time, and never ends below the floor', () => {
    const domain = domainOf([{ minute: 0, value: 0.002 }, { minute: 3, value: 0.004 }], AXIS_FLOOR.error_rate)
    expect(domain).toEqual({ fromMinute: 0, toMinute: MIN_SPAN_MINUTES, top: 0.05 })
  })

  it('grows with the data once the series is longer and higher than the floor', () => {
    const points: Point[] = Array.from({ length: 60 }, (_, minute) => ({ minute, value: minute * 20 }))
    expect(domainOf(points, AXIS_FLOOR.latency_p95)).toEqual({ fromMinute: 0, toMinute: 59, top: 2000 })
  })

  it('is a sensible empty domain for no points', () => {
    expect(domainOf([], 1)).toEqual({ fromMinute: 0, toMinute: MIN_SPAN_MINUTES, top: 1 })
  })
})

describe('drawing a series', () => {
  const domain = { fromMinute: 0, toMinute: 100, top: 10 }

  it('puts the first minute at the left of the plot and the last at the right, and zero at the bottom', () => {
    expect(xOf(0, domain, FRAME)).toBe(20)
    expect(xOf(100, domain, FRAME)).toBe(200)
    expect(yOf(0, domain, FRAME)).toBe(90)
    expect(yOf(10, domain, FRAME)).toBe(10)
  })

  it('keeps a value over the top of the scale on the plot', () => {
    expect(yOf(50, domain, FRAME)).toBe(10)
    expect(yOf(-5, domain, FRAME)).toBe(90)
  })

  it('writes the line as a path of moves and lines, and nothing for an empty series', () => {
    expect(pathOf([{ minute: 0, value: 0 }, { minute: 50, value: 5 }, { minute: 100, value: 10 }], domain, FRAME)).toBe('M20.0,90.0 L110.0,50.0 L200.0,10.0')
    expect(pathOf([], domain, FRAME)).toBe('')
  })

  it('states where the series started, peaked and ended, for the text alternative', () => {
    expect(factsOf([{ minute: 0, value: 1 }, { minute: 5, value: 9 }, { minute: 9, value: 4 }])).toEqual({ first: 1, last: 4, peak: 9, peakMinute: 5, lastMinute: 9 })
    expect(factsOf([])).toBeUndefined()
  })
})

describe('the health of a service, on the real simulator', () => {
  it('reads the ticks of a log, in order, one for each minute', async () => {
    const { events, view } = await playIncident({ sampleId: 'bad-deploy' })
    const ticks = ticksOf(events)
    expect(ticks.map(tick => tick.minute)).toEqual([...ticks.map(tick => tick.minute)].sort((a, b) => a - b))
    expect(ticks.at(-1)?.minute).toBe(view.minute)
    const series = seriesOf(ticks, 'cart', 'error_rate')
    expect(series).toHaveLength(ticks.length)
    expect(series[0]?.value).toBeLessThan(0.01)
  })

  for (const fault of LB06_FAULTS) {
    it(`calls every service normal in the calm before ${fault}, and the service it strikes not normal when the agents propose a fix`, async () => {
      const sampleId = fault.replaceAll('_', '-')
      const { events } = await playIncident({ sampleId })
      const ticks = ticksOf(events)
      const calm = ticks.slice(0, 30)
      expect(SERVICES.map(service => healthOf(calm, service))).toEqual(SERVICES.map(() => 'normal'))
      const proposed = events.findIndex(event => event.kind === 'proposal.made')
      const untilProposal = ticksOf(events.slice(0, proposed))
      expect(healthOf(untilProposal, STRUCK[fault])).not.toBe('normal')
    })
  }

  it('has no opinion before the first minute', () => {
    expect(healthOf([], 'web')).toBeUndefined()
  })
})
