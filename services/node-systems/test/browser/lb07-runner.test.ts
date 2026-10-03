// LB-07's runner on a real Chromium, over the real shop: every golden reference plan is executed step by
// step through the runner's HTTP API, with the bugs its case switches on, and the findings code makes are
// the ones the bug catalogue's truths describe; a clean shop makes none. The two layers of the sandbox
// are proved here: a step that would leave the shop is refused before the browser moves (a `goto` to
// another origin, a link whose href points outside, `file:`, `javascript:`, a private address, the cloud
// metadata address) and recorded, and a request the page itself makes to another origin is aborted.
// The sessions' limits are proved too: one at a time, a wall clock that closes the context, and a runner
// that declares itself exhausted after its share of runs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Lb07Step } from '@lb/contracts'

import { matchesTruth } from '../../src/modules/lb07/data/bugs.ts'
import { RunnerError } from '../../src/modules/lb07/runner/client.ts'
import { decideShopPath, decideUrl } from '../../src/modules/lb07/runner/guard.ts'
import { loadCatalogue, loadGolden } from '../support/lb07.ts'
import { runPlan, startRunnerHarness } from '../support/lb07-runner.ts'
import type { RunnerHarness } from '../support/lb07-runner.ts'
import { tokenFor } from '../support/lb07-shop.ts'

const catalogue = loadCatalogue()
const golden = loadGolden()
// The cases whose reference plan runs to the end without a re-plan.
const straight = golden.filter(entry => entry.replans.length === 0)

describe('the URL guard', () => {
  const shop = 'http://127.0.0.1:8007'

  it('allows paths of the shop and refuses everything else, before any browser is asked', () => {
    expect(decideShopPath('/cart', shop)).toMatchObject({ allowed: true })
    expect(decideShopPath('//evil.test/x', shop)).toMatchObject({ allowed: false, reason: 'other_origin', target: 'http://evil.test' })
    for (const raw of ['http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'https://wholesale.basalt-bean.test/', 'http://127.0.0.1:9999/']) {
      expect(decideUrl(raw, `${shop}/about`, shop)).toMatchObject({ allowed: false, reason: 'other_origin' })
    }
    for (const raw of ['file:///etc/passwd', 'data:text/html,hi', ['javascript', 'alert(1)'].join(':'), 'blob:http://127.0.0.1:8007/x', 'ftp://x/']) {
      expect(decideUrl(raw, `${shop}/about`, shop)).toMatchObject({ allowed: false, reason: 'scheme' })
    }
    expect(decideUrl('relative/page', `${shop}/about`, shop)).toMatchObject({ allowed: true })
    expect(decideUrl('::not a url::', 'not a base', shop)).toMatchObject({ allowed: false, reason: 'not_a_url' })
  })
})

describe('the runner over the shop in a real Chromium', () => {
  let harness: RunnerHarness
  beforeAll(async () => {
    harness = await startRunnerHarness()
  })
  afterAll(() => harness.close())

  it.each(straight.map(entry => [entry.id, entry] as const))('runs the reference plan of %s and finds what its bugs plant, and nothing else on a clean shop', async (_id, entry) => {
    const run = await runPlan(harness.runner, entry.plan, { bugToken: entry.bugs.length === 0 ? null : tokenFor(entry.bugs, 'run-golden-0001') })
    expect(run.offOriginRequests).toBe(0)
    expect(run.blocked).toBe(entry.expect.blocked)
    for (const bug of entry.expect.found) {
      // The engine-specific bug is found in the second engine, which the worker runs after the first: not here.
      if (bug === 'checkout-engine') continue
      const truth = catalogue.get(bug)!.truth
      expect(run.findings.some(finding => matchesTruth(truth, finding)), `${bug} found`).toBe(true)
    }
    if (entry.bugs.length === 0) {
      expect(run.findings.filter(finding => finding.kind !== 'blocked_navigation')).toEqual([])
    }
    if (entry.expect.blocked > 0) {
      expect(run.steps.some(step => step.outcome === 'blocked')).toBe(true)
    }
    else {
      expect(run.steps.every(step => step.outcome === 'ok' || step.outcome === 'expectation')).toBe(true)
    }
  })

  it('finds the engine-specific checkout failure only in the simulated second engine', async () => {
    const entry = golden.find(candidate => candidate.id === 'checkout-in-firefox')!
    const token = tokenFor(['checkout-engine'], 'run-engine-00001')
    const chromium = await runPlan(harness.runner, entry.plan, { bugToken: token, engine: 'chromium', axe: false })
    expect(chromium.findings).toEqual([])
    const firefox = await runPlan(harness.runner, entry.plan, { bugToken: token, engine: 'firefox-ua', axe: false })
    const truth = catalogue.get('checkout-engine')!.truth
    expect(firefox.findings.some(finding => matchesTruth(truth, finding))).toBe(true)
    expect(firefox.steps.filter(step => step.outcome === 'expectation')).toHaveLength(2)
  })

  it('refuses a goto to another origin and a link out of the shop before the browser moves, and aborts a request the page makes elsewhere', async () => {
    const plan: Lb07Step[] = [
      { action: 'goto', path: '/about' },
      { action: 'click', role: 'link', name: 'Roastery weather station' },
      { action: 'click', role: 'link', name: 'Warehouse intranet' },
      { action: 'click', role: 'link', name: 'Price list (file)' },
      { action: 'click', role: 'link', name: 'Say hello' },
      { action: 'click', role: 'link', name: 'Wholesale portal' },
    ]
    const run = await runPlan(harness.runner, plan, { bugToken: null, axe: false })
    // The first refused link ends the plan, as it does in the engine; the other links are refused one by one in sessions of their own below.
    expect(run.steps.map(step => step.outcome)).toEqual(['ok', 'blocked'])
    expect(run.steps.every(step => step.path === '/about')).toBe(true)
    expect(run.blocked).toBe(1)
    for (const name of ['Warehouse intranet', 'Price list (file)', 'Say hello', 'Wholesale portal']) {
      const one = await runPlan(harness.runner, [{ action: 'goto', path: '/about' }, { action: 'click', role: 'link', name }], { bugToken: null, axe: false })
      expect(one.steps.map(step => step.outcome)).toEqual(['ok', 'blocked'])
      run.findings.push(...one.findings)
    }
    expect(run.offOriginRequests).toBe(0)
    const targets = run.findings.filter(finding => finding.kind === 'blocked_navigation').map(finding => finding.detail)
    expect(targets.some(detail => detail.includes('http://169.254.169.254'))).toBe(true)
    expect(targets.some(detail => detail.includes('file: address'))).toBe(true)
    expect(targets.some(detail => detail.includes(`${['java', 'script'].join('')}: address`))).toBe(true)
    // A `goto` outside the shop, as a raw step the schema (and so the runner's API) already refuses: the executor refuses it too, straight on the sessions.
    const sessionId = await harness.sessions.open({ runId: 'run-raw-goto-001', engine: 'chromium', bugToken: null, wallClockMs: 10_000 })
    const raw = await harness.sessions.step(sessionId, 0, { action: 'goto', path: '//evil.test/x' } as Lb07Step)
    const closed = await harness.sessions.close(sessionId)
    expect(raw.outcome).toBe('blocked')
    expect(raw.findings[0]?.detail).toContain('http://evil.test')
    expect(closed.blocked).toBe(1)
  })

  it('tells a step that names nothing, an ambiguous one and a hostile name apart, and survives quotes, backticks and markup in names', async () => {
    const plan: Lb07Step[] = [
      { action: 'goto', path: '/' },
      { action: 'click', role: 'button', name: 'Add to basket' },
      { action: 'click', role: 'link', name: 'Shop' },
      { action: 'click', role: 'button', name: '"><script>alert(`${1}`)</script>' },
      { action: 'fill', label: 'Coupon code', value: 'x' },
      { action: 'expectCount', role: 'heading', count: 7 },
      { action: 'expectText', text: 'Nothing says this' },
    ]
    const run = await runPlan(harness.runner, plan, { bugToken: null, axe: false })
    expect(run.steps.map(step => step.outcome)).toEqual(['ok', 'not_found', 'ok', 'not_found', 'not_found', 'ok', 'expectation'])
    expect(run.findings.map(finding => finding.kind)).toEqual(['expectation_failed'])
  })

  it('hands over a trimmed snapshot and a screenshot, keeps one session at a time, and closes a session at its wall clock', async () => {
    const sessionId = await harness.runner.open({ runId: 'run-limits-00001', engine: 'chromium', bugToken: null, wallClockMs: 2_500 })
    await expect(harness.runner.open({ runId: 'run-limits-00002', engine: 'chromium', bugToken: null, wallClockMs: 10_000 })).rejects.toMatchObject({ code: 'busy' })
    await harness.runner.step(sessionId, 0, { action: 'goto', path: '/about' })
    const snapshot = await harness.runner.snapshot(sessionId)
    expect(snapshot.path).toBe('/about')
    expect(snapshot.text).toContain('Partner links')
    expect(snapshot.text).not.toMatch(/[<>]/)
    expect(snapshot.text.length).toBeLessThanOrEqual(6_000)
    const shot = await harness.runner.screenshot(sessionId)
    expect(shot.base64.length).toBeGreaterThan(1_000)
    await new Promise(resolve => setTimeout(resolve, 3_000))
    await expect(harness.runner.step(sessionId, 1, { action: 'goto', path: '/' })).rejects.toMatchObject({ code: 'expired' })
    const closed = await harness.runner.close(sessionId)
    expect(closed.offOriginRequests).toBe(0)
    await expect(harness.runner.close(sessionId)).rejects.toBeInstanceOf(RunnerError)
    expect((await harness.runner.health()).busy).toBe(false)
  })
})

describe('a runner with a short life', () => {
  it('declares itself exhausted after its share of runs and refuses the next', async () => {
    const harness = await startRunnerHarness(2)
    try {
      for (const runId of ['run-life-000001', 'run-life-000002']) {
        const sessionId = await harness.runner.open({ runId, engine: 'chromium', bugToken: null, wallClockMs: 10_000 })
        await harness.runner.close(sessionId)
      }
      expect((await harness.runner.health()).exhausted).toBe(true)
      expect(harness.exhaustedCalls).toBe(1)
      await expect(harness.runner.open({ runId: 'run-life-000003', engine: 'chromium', bugToken: null, wallClockMs: 10_000 })).rejects.toMatchObject({ code: 'exhausted' })
    }
    finally {
      await harness.close()
    }
  })
})
