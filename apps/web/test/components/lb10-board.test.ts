// Tests of LB-10's whole board, mounted against the fake site and the mock back end's LB-10: the board on opening (the
// prompts, the editor on production's prompt, the providers, the honest empty nightly and baselines); an edit run live
// to its report (figure 1 with its words and table, figure 2 and its verdict, every changed case with both replies and
// what each grader said); a prepared edit on two providers whose replies are prose (malformed, never repaired, worse);
// an unchanged prompt that runs once; the checks as the visitor types and the service's own refusal listed beside the
// prompt; the day's run, a busy lab, a run still going, a lab with no gateway, each failure of a run in its own words
// with whether it was given back; the Scope; a replay with no request that could change anything; a run opened again
// from the visitor's runs of today; the nightly results when there are some; the Brief reading; a deployment with no
// back end; and the whole of it in Czech.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { recordingSchema } from '@lb/contracts'
import type { Recording } from '@lb/contracts'
import { flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Lb10Board from '~/boards/lb-10/Lb10Board.vue'
import { useReadingStore } from '~/stores/reading'
import type { FakeLb10Options } from '../support/lb10-site'
import { FakeLb10Site } from '../support/lb10-site'
import { mountWithSite } from '../support/mount'

const FIXTURES = join(import.meta.dirname, '../../e2e/fixtures/recordings/lb-10')

/** One of the committed recordings, made to look like a real one (the site shows only those). */
function liveRecording(sample: string): Recording {
  return recordingSchema.parse({ ...JSON.parse(readFileSync(join(FIXTURES, `${sample}.json`), 'utf8')) as object, origin: 'live' })
}

/** Answers the page's questions about its screen: a narrow one, with motion. */
function stubScreen(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }))
}

/** Mounts the board against a fake site and waits for what it reads when it opens. */
async function openBoard(options: FakeLb10Options & { locale?: 'en' | 'cs', brief?: boolean, site?: FakeLb10Site } = {}) {
  const { locale, brief, site: given, ...siteOptions } = options
  stubScreen()
  const site = given ?? new FakeLb10Site({ verified: true, ...siteOptions })
  vi.stubGlobal('fetch', site.fetch)
  vi.stubGlobal('location', new URL('http://site.test/'))
  const wrapper = mountWithSite(Lb10Board, { locale, props: { permalinkFor: (id: string) => `/runs/${id}`, now: Date.parse('2026-10-05T09:30:00.000Z') } })
  if (brief) useReadingStore().mode = 'brief'
  await flushPromises()
  await vi.advanceTimersByTimeAsync(0)
  await flushPromises()
  return { site, wrapper }
}

/** Lets a number of milliseconds pass, with the board's timers running. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
}

/** Lets time pass in small steps until a condition holds, or fails after a while. */
async function until(condition: () => boolean, what: string, limitMs = 30_000): Promise<void> {
  for (let waited = 0; waited < limitMs && !condition(); waited += 100) await advance(100)
  expect(condition(), `waited for ${what}`).toBe(true)
}

/** The text of an element, with its spaces folded. */
function textOf(wrapper: VueWrapper, selector: string): string {
  return wrapper.get(selector).text().replace(/\s+/g, ' ')
}

/** The state the run on the board says it is in, or nothing when there is no run. */
function runState(wrapper: VueWrapper): string | undefined {
  const state = wrapper.find('[data-testid="run-state"]')
  return state.exists() ? state.attributes('data-state') : undefined
}

/** Tells whether the run on the board has ended and the day's count was read again. */
function ended(wrapper: VueWrapper): boolean {
  return ['done', 'failed'].includes(runState(wrapper) ?? '') && !wrapper.text().includes('Checking whether the run was given back')
}

/** Picks one of the five prompts. */
async function chooseTarget(wrapper: VueWrapper, pack: string): Promise<void> {
  await wrapper.get(`[data-testid="target-${pack}"] input`).setValue(true)
}

/** Types into the editor, as a visitor would. */
async function type(wrapper: VueWrapper, text: string): Promise<void> {
  await wrapper.get('[data-testid="prompt-input"]').setValue(text)
}

/** The prompt in the editor. */
function prompt(wrapper: VueWrapper): string {
  return (wrapper.get('[data-testid="prompt-input"]').element as HTMLTextAreaElement).value
}

/** Starts the edit in the editor live. */
async function runIt(wrapper: VueWrapper): Promise<void> {
  await wrapper.get('[data-testid="run-live"]').trigger('click')
  await advance(300)
}

/** Picks a prepared edit and runs it live. */
async function runSample(wrapper: VueWrapper, id: string): Promise<void> {
  await wrapper.get(`[data-testid="sample-${id}"] input`).setValue(true)
  await wrapper.get('[data-testid="live-sample"]').trigger('click')
  await advance(300)
}

describe('LB-10\'s board', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-05T09:30:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('opens on LB-01\'s drafter, its production prompt in the editor, Groq chosen, the day\'s run and an honest empty nightly', async () => {
    const { wrapper } = await openBoard()
    expect(wrapper.findAll('[data-testid^="target-lb"] input')).toHaveLength(5)
    expect(wrapper.get('[data-testid="target-details"]').attributes('data-pack')).toBe('lb01-drafter')
    expect(textOf(wrapper, '[data-testid="target-grades"]')).toContain('cites the policy passages')
    expect(textOf(wrapper, '[data-testid="target-cannot"]')).toContain('numbers a reply must mention')
    expect(textOf(wrapper, '[data-testid="target-variables"]')).toBe('{{language}}')
    expect(prompt(wrapper)).toContain('You draft replies to customer support tickets')
    expect(wrapper.find('[data-testid="prompt-unchanged"]').exists()).toBe(true)
    expect(textOf(wrapper, '[data-testid="prompt-count"]')).toBe('1,563 of 8,000 characters')
    expect(wrapper.get('[data-testid="reset-prompt"]').attributes('disabled')).toBeDefined()
    expect(wrapper.findAll('[data-testid="target-case"]')).toHaveLength(10)
    expect((wrapper.get('[data-testid="provider-groq"] input').element as HTMLInputElement).checked).toBe(true)
    expect((wrapper.get('[data-testid="provider-workers-ai"] input').element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.text()).toContain('OpenRouter is not offered')
    expect(textOf(wrapper, '[data-testid="run-cost"]')).toBe('Production\'s prompt alone: up to 10 model calls, and none if its results are already cached.')
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('1 of 1')
    expect(textOf(wrapper, '[data-testid="no-nightly"]')).toContain('it has not been run live')
    expect(textOf(wrapper, '[data-testid="no-judge"]')).toContain('has not been run live yet')
    expect(textOf(wrapper, '[data-testid="no-baselines"]')).toContain('No baseline is committed until one is measured on a live run')
    expect(wrapper.find('[data-testid="no-recording"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="run-panel"]').exists()).toBe(false)
  })

  it('runs an edit live and shows the run, then the report: the scores, the difference, its verdict and the case that changed', async () => {
    const { site, wrapper } = await openBoard()
    const production = prompt(wrapper)
    await type(wrapper, `${production}\nKeep it short.`)
    expect(textOf(wrapper, '[data-testid="prompt-changed"]')).toContain('1 line added')
    expect(textOf(wrapper, '[data-testid="run-cost"]')).toContain('Up to 10 model calls for your prompt, and up to 10 more for production\'s')
    await runIt(wrapper)
    expect(site.callsTo('/api/lb10/runs', 'POST')[0]?.body).toEqual({ target: 'lb01-drafter', prompt: `${production}\nKeep it short.`, providers: ['groq'] })
    expect(runState(wrapper)).toBe('running')
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuemax')).toBe('20')
    await until(() => ended(wrapper), 'the run to end')

    expect(runState(wrapper)).toBe('done')
    expect(textOf(wrapper, '[data-testid="run-calls"]')).toBe('20 of 20')
    expect(textOf(wrapper, '[data-testid="small-sample"]')).toContain('Ten cases is a small sample')
    const words = textOf(wrapper, '[data-testid="score-words"]')
    expect(words).toContain('Groq, production\'s prompt: 90% passed, interval')
    expect(words).toContain('Groq, your prompt: 100% passed')
    expect(wrapper.findAll('[data-testid="report-row"]').map(row => row.attributes('data-variant'))).toEqual(['production', 'edited'])
    // The table is named by its numbered title, which sits above the box that scrolls it so it never runs off with it.
    const title = wrapper.get('[data-testid="report-table"]').attributes('aria-labelledby') ?? ''
    expect(wrapper.get(`[id="${title}"]`).text()).toBe('Table 1. The numbers of figure 1, and what each prompt cost')
    expect(wrapper.get('[data-testid="verdict"]').attributes('data-verdict')).toBe('no_detectable_difference')
    expect(textOf(wrapper, '[data-testid="verdict"]')).toContain('this run cannot tell the two prompts apart')
    const changed = wrapper.findAll('[data-testid="changed-case"]')
    expect(changed).toHaveLength(1)
    expect(changed[0]?.attributes('data-change')).toBe('improved')
    const replies = changed[0]!.findAll('[data-testid="reply"]')
    expect(replies.map(reply => reply.attributes('data-side'))).toEqual(['production', 'edited'])
    expect(replies[1]?.find('ins').exists()).toBe(true)
    expect(replies[0]?.text()).toContain('Cites the expected sources: Failed')
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('0 of 1')
    expect(wrapper.findAll('[data-testid="my-run"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="all-cases"]').exists()).toBe(true)
    // The visitor's prompt never goes into the address, the title or the browser's storage.
    expect(window.location.href).not.toContain('Keep')
    expect(document.title).not.toContain('Keep')
  })

  it('runs a prepared edit on both providers: prose instead of JSON, every case failed, never repaired, and worse', async () => {
    const { wrapper } = await openBoard()
    await runSample(wrapper, 'classifier-without-json')
    await until(() => ended(wrapper), 'the run to end')
    expect(wrapper.findAll('[data-testid="verdict"]').map(item => item.attributes('data-verdict'))).toEqual(['worse', 'worse'])
    expect(textOf(wrapper, '[data-testid="verdict"]')).toContain('Worse: the whole interval is below zero')
    expect(wrapper.findAll('[data-testid="report-row"]')).toHaveLength(4)
    const first = wrapper.get('[data-testid="changed-case"]')
    expect(first.attributes('data-change')).toBe('regressed')
    expect(first.get('[data-side="edited"] [data-testid="reply-malformed"]').text()).toContain('it is never repaired')
    expect(first.find('[data-testid="diff-unrelated"]').exists()).toBe(true)
    expect(first.get('[data-side="production"]').text()).toContain('Shown re-indented')
    expect(first.get('[data-side="edited"]').text()).toContain('Shown exactly as written')
    // Every case that changed is listed; the first two of a provider show their replies, the rest open on a click.
    const groq = wrapper.findAll('[data-provider="groq"] [data-testid="changed-case"]')
    expect(groq.length).toBeGreaterThan(2)
    expect(groq.map(item => (item.get('[data-testid="case-replies"]').element as HTMLDetailsElement).open)).toEqual(groq.map((_, index) => index < 2))
  })

  it('runs an unchanged prompt once, and says its report has nothing to compare', async () => {
    const { site, wrapper } = await openBoard()
    await chooseTarget(wrapper, 'lb05-sql-writer')
    expect(textOf(wrapper, '[data-testid="prompt-count"]')).toBe('7,266 of 8,000 characters')
    await runIt(wrapper)
    await until(() => ended(wrapper), 'the run to end')
    expect(site.callsTo('/api/lb10/runs', 'POST')).toHaveLength(1)
    expect(textOf(wrapper, '[data-testid="run-calls"]')).toBe('10 of 10')
    expect(wrapper.find('[data-testid="unchanged-report"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="difference-figure"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="report-row"]')).toHaveLength(1)
  })

  it('checks the prompt as the visitor types, keeps the run back until it can run, and puts production\'s prompt back', async () => {
    const { site, wrapper } = await openBoard()
    await chooseTarget(wrapper, 'lb02-planner')
    const production = prompt(wrapper)
    await type(wrapper, `${production.replace('{{language}}', 'English')} {{tomorrow}}\u0007`)
    const checks = wrapper.findAll('[data-testid="prompt-checks"] li').map(item => item.attributes('data-code'))
    expect(checks).toEqual(['not_text', 'missing_variables', 'unknown_variables'])
    expect(textOf(wrapper, '[data-testid="prompt-checks"]')).toContain('Put back the variables the cases fill: {{language}}.')
    // Each chip's parts are flex items, which assistive technology reads as separate words.
    expect(wrapper.get('[data-testid="prompt-variables"] [data-kept="false"]').findAll('span').map(part => part.text())).toEqual(['{{language}}', 'missing'])
    expect(wrapper.get('[data-testid="prompt-variables"] [data-unknown="true"]').findAll('span').map(part => part.text())).toEqual(['{{tomorrow}}', 'Not a variable of this pack'])
    expect(wrapper.get('[data-testid="prompt-input"]').attributes('aria-invalid')).toBe('true')
    expect(wrapper.get('[data-testid="run-live"]').attributes('disabled')).toBeDefined()
    await type(wrapper, 'x'.repeat(8_100))
    expect(textOf(wrapper, '[data-testid="prompt-checks"]')).toContain('Shorten it by 100 characters: it is 8,100, and at most 8,000 are allowed.')
    await wrapper.get('[data-testid="reset-prompt"]').trigger('click')
    expect(prompt(wrapper)).toBe(production)
    expect(wrapper.find('[data-testid="prompt-checks"]').exists()).toBe(false)
    expect(site.callsTo('/api/lb10/runs', 'POST')).toHaveLength(0)
  })

  it('lists the service\'s own refusal of a prompt beside the editor, in the visitor\'s words, until the prompt changes', async () => {
    const { site, wrapper } = await openBoard()
    await type(wrapper, `${prompt(wrapper)}\nOne more rule.`)
    site.failNext('POST /api/lb10/runs', { status: 422, body: { error: { code: 'invalid_prompt', message: 'The prompt dropped a variable the cases fill: {{language}}.' }, problems: [{ code: 'missing_variables', message: 'The prompt dropped a variable the cases fill: {{language}}.' }, { code: 'brand_new_rule', message: 'A rule this page has never seen.' }] } })
    await runIt(wrapper)
    const refused = wrapper.get('[data-testid="prompt-refused"]')
    expect(refused.attributes('role')).toBe('alert')
    expect(refused.findAll('li').map(item => item.attributes('data-code'))).toEqual(['missing_variables', 'other'])
    expect(refused.text()).toContain('A rule this page has never seen.')
    expect(refused.text()).toContain('Nothing was counted')
    expect(wrapper.find('[data-testid="own-notice"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="notice"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('1 of 1')
    await type(wrapper, `${prompt(wrapper)} Changed.`)
    expect(wrapper.find('[data-testid="prompt-refused"]').exists()).toBe(false)
  })

  it('says the day\'s run is used, with when it starts again, and keeps the replays open', async () => {
    const { wrapper } = await openBoard({ recordings: [liveRecording('drafter-word-limit')] })
    await type(wrapper, `${prompt(wrapper)}\nA.`)
    await runIt(wrapper)
    await until(() => ended(wrapper), 'the run to end')
    expect(wrapper.find('[data-testid="allowance-used"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="run-live"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="replay-sample"]').attributes('disabled')).toBeUndefined()
  })

  it('says the day\'s run is used in the lab\'s own words when the service refuses it, with when it starts again', async () => {
    const { site, wrapper } = await openBoard()
    site.failNext('POST /api/lb10/runs', { status: 429, body: { error: { code: 'daily_limit', message: 'You have started today\'s run.', resets_at: '2026-10-06T00:00:00+00:00' } } })
    await runIt(wrapper)
    expect(wrapper.get('[data-testid="own-notice"]').attributes('data-notice')).toBe('daily_limit')
    expect(textOf(wrapper, '[data-testid="own-notice"]')).toMatch(/It starts again at .*2026.* UTC\./)
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('0 of 1')
    expect(wrapper.find('[data-testid="run-panel"]').exists()).toBe(false)
  })

  it('says a run is still going in the lab\'s own words', async () => {
    const { site, wrapper } = await openBoard()
    site.failNext('POST /api/lb10/runs', { status: 429, body: { error: { code: 'run_running', message: 'Your run is still going.' } } })
    await runIt(wrapper)
    expect(wrapper.get('[data-testid="own-notice"]').attributes('data-notice')).toBe('run_running')
    expect(textOf(wrapper, '[data-testid="own-notice"]')).toContain('Your run is still going')
  })

  it('says the lab is busy, and that nothing was counted', async () => {
    const { site, wrapper } = await openBoard()
    site.lb10.control('busy', {})
    await runIt(wrapper)
    expect(wrapper.get('[data-testid="own-notice"]').attributes('data-notice')).toBe('lab_busy')
    expect(textOf(wrapper, '[data-testid="own-notice"]')).toContain('nothing was counted')
    await advance(500)
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('1 of 1')
    expect(site.callsTo('/api/lb10/runs/', 'GET')).toHaveLength(0)
  })

  it('says when the lab has no gateway, and runs nothing', async () => {
    const site = new FakeLb10Site({ verified: true })
    site.lb10.control('unavailable', { on: true })
    const { wrapper } = await openBoard({ site })
    expect(wrapper.find('[data-testid="no-gateway"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="run-live"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="live-sample"]').attributes('disabled')).toBeDefined()
  })

  it.each([
    ['no_answers', 'No model answered any call', 'given'],
    ['model_budget', 'The free model budget ran out', 'given'],
    ['time_limit', 'The run passed its five minutes', 'given'],
    ['interrupted', 'The service stopped while the run was going', 'given'],
  ])('says why a run failed (%s) and that it was given back', async (code, words, refund) => {
    const { site, wrapper } = await openBoard()
    site.lb10.control('fail', { code })
    await type(wrapper, `${prompt(wrapper)}\nB.`)
    await runIt(wrapper)
    await until(() => ended(wrapper), 'the run to end')
    expect(runState(wrapper)).toBe('failed')
    expect(wrapper.get('[data-testid="run-failure"]').attributes('data-failure')).toBe(code)
    expect(textOf(wrapper, '[data-testid="run-failure"]')).toContain(words)
    expect(wrapper.get('[data-testid="refund"]').attributes('data-refund')).toBe(refund)
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('1 of 1')
    expect(wrapper.find('[data-testid="report"]').exists()).toBe(false)
  })

  it('says a failed run was not given back once the day\'s two refunds are spent', async () => {
    const { site, wrapper } = await openBoard()
    for (const code of ['no_answers', 'model_budget', 'time_limit']) {
      site.lb10.control('fail', { code })
      await type(wrapper, `${prompt(wrapper)}\n${code}.`)
      await runIt(wrapper)
      await until(() => ended(wrapper), `the ${code} run to end`)
    }
    expect(wrapper.get('[data-testid="refund"]').attributes('data-refund')).toBe('not_given')
    expect(textOf(wrapper, '[data-testid="refund"]')).toContain('it has already given back two runs today')
    expect(wrapper.get('[data-testid="quota"]').text()).toContain('0 of 1')
  })

  it('shows a call that got no answer as a failed case naming the gateway\'s reason', async () => {
    const { site, wrapper } = await openBoard()
    site.lb10.control('fail-calls', { code: 'upstream_failed', count: 2 })
    await type(wrapper, `${prompt(wrapper)}\nC.`)
    await runIt(wrapper)
    await until(() => ended(wrapper), 'the run to end')
    expect(wrapper.findAll('[data-testid="reply-no-answer"]').map(item => item.text())).toContain('No answer: the provider failed.')
    // The verdict that rests on them says so, with the gateway's reason.
    expect(textOf(wrapper, '[data-testid="verdict-unanswered"]')).toBe('2 calls on Groq got no answer (the provider failed). Each counts as a failed case, so this verdict says as much about the provider as about the prompts.')
  })

  it('follows the run\'s trace in the Scope, and keeps the prompt out of it', async () => {
    const { site, wrapper } = await openBoard()
    await type(wrapper, `${prompt(wrapper)}\nzebrapotato.`)
    await runIt(wrapper)
    await until(() => ended(wrapper), 'the run to end')
    await advance(3_000)
    expect(site.callsTo('/api/runs/').length).toBeGreaterThan(0)
    expect(wrapper.text()).toContain('eval run')
    expect(wrapper.text()).toContain('read cache')
    expect(JSON.stringify(site.callsTo('/api/runs/'))).not.toContain('zebrapotato')
  })

  it('replays a prepared edit\'s recording with the edit in the editor, sending nothing that could change anything', async () => {
    const { site, wrapper } = await openBoard({ recordings: [liveRecording('drafter-word-limit')] })
    await wrapper.get('[data-testid="replay-sample"]').trigger('click')
    await until(() => runState(wrapper) === 'done' && wrapper.find('[data-testid="report"]').exists(), 'the replay to end', 20_000)
    expect(wrapper.get('[data-testid="board-state"]').text()).toContain('Replay')
    expect(wrapper.find('[data-testid="replay-banner"]').exists()).toBe(true)
    expect(prompt(wrapper)).toContain('- Keep the whole reply under 80 words.')
    expect(site.calls.filter(call => call.method !== 'GET')).toHaveLength(0)
    expect(wrapper.find('[data-testid="replaying-note"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="verdict"]').attributes('data-verdict')).toBe('no_detectable_difference')
  })

  it('opens a run of today again after a reload: its report, and a note that the prompt was not kept', async () => {
    const site = new FakeLb10Site({ verified: true })
    const first = await openBoard({ site })
    await type(first.wrapper, `${prompt(first.wrapper)}\nD.`)
    await runIt(first.wrapper)
    await until(() => ended(first.wrapper), 'the run to end')
    first.wrapper.unmount()

    const { wrapper } = await openBoard({ site })
    expect(wrapper.find('[data-testid="run-panel"]').exists()).toBe(false)
    const listed = wrapper.findAll('[data-testid="my-run"]')
    expect(listed).toHaveLength(1)
    await listed[0]!.get('[data-testid="open-run"]').trigger('click')
    await until(() => wrapper.find('[data-testid="report"]').exists(), 'the run to open')
    expect(wrapper.find('[data-testid="reopened-note"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="verdict"]').attributes('data-verdict')).toBe('no_detectable_difference')
  })

  it('shows the nightly\'s results, the judge\'s standing in words and the baselines, and leaves out a row it cannot read', async () => {
    const site = new FakeLb10Site({ verified: true })
    site.lb10.control('nightly', {
      results: [
        { run_on: '2026-10-04', kind: 'eval', pack: 'lb01-drafter', pack_version: '0123456789abcdef', alias: 'lb-eval-groq-120b', report: { provider: 'groq', score: { mean: 0.8, low: 0.55, high: 1, cases: 10 }, latency_p50_ms: 900, model_calls: 2, cached_calls: 8, failed_calls: 0 } },
        { run_on: '2026-10-04', kind: 'judge', pack: 'lb01-drafter', pack_version: '0123456789abcdef', alias: 'lb-eval-groq-120b', report: { counts: false, judged: 10, unreadable_verdicts: 0, judge_pass_rate: 0.7, judge_low: 0.4, judge_high: 0.9, rule_pass_rate: 0.8, agreement_with_rules: 0.9 } },
        { run_on: '2026-10-04', kind: 'eval', pack: 'lb01-drafter', pack_version: '0123456789abcdef', alias: 'lb-eval-cf-120b', report: { surprise: true } },
      ],
    })
    site.lb10.control('baselines', { baselines: [{ pack: 'lb01-drafter', pack_version: '0123456789abcdef', alias: 'lb-eval-groq-120b', score: 0.8, low: 0.6, high: 1, cases: 20, measured_on: '2026-10-01', source: 'live' }] })
    const { wrapper } = await openBoard({ site })
    expect(textOf(wrapper, '[data-testid="nightly-results"]')).toContain('LB-01 reply drafter')
    expect(textOf(wrapper, '[data-testid="nightly-results"]')).toContain('80%')
    expect(wrapper.get('[data-testid="judge-row"]').attributes('data-counts')).toBe('false')
    expect(textOf(wrapper, '[data-testid="nightly-judge"]')).toContain('Does not count')
    expect(wrapper.find('[data-testid="nightly-unreadable"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="baseline-row"]')).toHaveLength(1)
    expect(textOf(wrapper, '[data-testid="baselines"]')).toContain('on live providers')
  })

  it('leaves the latency, the tokens, every case and the pack\'s version out of the Brief reading', async () => {
    const { wrapper } = await openBoard({ brief: true })
    await type(wrapper, `${prompt(wrapper)}\nE.`)
    await runIt(wrapper)
    await until(() => ended(wrapper), 'the run to end')
    expect(wrapper.find('[data-testid="report-table"]').text()).not.toContain('Median latency')
    expect(wrapper.find('[data-testid="all-cases"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="report-pack"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="changed-case"]').exists()).toBe(true)
  })

  it('says the demo is not connected on a deployment with no back end, and runs nothing', async () => {
    const { site, wrapper } = await openBoard({ available: false })
    expect(wrapper.get('[data-testid="notice"]').attributes('data-kind')).toBe('unavailable')
    expect(wrapper.find('[data-testid="prompt-input"]').exists()).toBe(false)
    expect(site.callsTo('/api/lb10/')).toHaveLength(0)
  })

  it('says all of it in Czech: the prompts, the editor, the run and the report', async () => {
    const { wrapper } = await openBoard({ locale: 'cs' })
    expect(textOf(wrapper, '[data-testid="prompt-count"]')).toBe('1 563 z 8 000 znaků')
    expect(textOf(wrapper, '[data-testid="target-grades"]')).toContain('Že odpověď cituje')
    await type(wrapper, `${prompt(wrapper)}\nKrátce.`)
    expect(textOf(wrapper, '[data-testid="prompt-changed"]')).toContain('1 řádek přidán')
    await runIt(wrapper)
    await until(() => ended(wrapper), 'the run to end')
    expect(textOf(wrapper, '[data-testid="run-state"]')).toContain('Hotovo')
    expect(textOf(wrapper, '[data-testid="small-sample"]')).toContain('Deset případů je malý vzorek')
    expect(textOf(wrapper, '[data-testid="verdict"]')).toContain('Žádný prokazatelný rozdíl')
    expect(textOf(wrapper, '[data-testid="score-words"]')).toContain('Groq, produkční prompt: zvládnuto 90')
    expect(wrapper.text()).not.toContain('Production\'s prompt')
  })
})
