// Integration tests for speech to text: the route's permissions, its limits, the way a
// recording is measured from its bytes, fallback between the two kinds of provider, the
// data-class rule, the budgets in seconds of audio, and what the spans and the log leave out.
import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { groqTranscription, workersTranscription } from '../support/fake-provider.ts'
import { multipart, transcriptionParts, wav, wavHeader } from '../support/audio.ts'
import type { Part } from '../support/audio.ts'
import { chatBody, startGateway } from '../support/gateway.ts'
import type { TestGateway } from '../support/gateway.ts'

let gw: TestGateway

beforeEach(async () => {
  gw = await startGateway()
})

afterEach(async () => {
  await gw.close()
})

/** The words the fake providers transcribe, which no span and no log line may ever hold. */
const WORDS = 'Marta will re-profile the Colombian by Wednesday'
const SPEECH: [number, number, string][] = [[0, 2.4, 'Good morning, everyone.'], [2.4, 5, WORDS]]

/** Sends a form to the transcription route as LB-09, with any header overridden or removed. */
async function transcribe(parts: readonly Part[], headers: Record<string, string | undefined> = {}) {
  const { payload, contentType } = await multipart(parts)
  const call = await gw.headers({ 'x-lb-system': 'lb-09', ...headers })
  return gw.app.inject({ method: 'POST', url: '/v1/audio/transcriptions', headers: { ...call, 'content-type': contentType }, payload })
}

/** The SHA-256 of some bytes, as hex, so a test can tell the recording that arrived from the one that was sent. */
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** One row of the /v1/usage report. */
interface UsageMeter {
  scope: string
  unit: string
  window: string
  used: number
  limit: number
}

/** Reads the /v1/usage report. */
async function usage(): Promise<UsageMeter[]> {
  const response = await gw.app.inject({ method: 'GET', url: '/v1/usage', headers: { authorization: `Bearer ${await gw.token()}` } })
  return response.json<{ meters: UsageMeter[] }>().meters
}

/** Finds one meter of the usage report by what it counts, over which window. */
async function meter(scope: string, unit: string, window: string): Promise<UsageMeter | undefined> {
  return (await usage()).find(row => row.scope === scope && row.unit === unit && row.window === window)
}

/** How many requests every fake provider received, in the order alpha, beta, gamma, delta. */
function received(): number[] {
  return [gw.providers.alpha, gw.providers.beta, gw.providers.gamma, gw.providers.delta].map(provider => provider.requests.length)
}

describe('a recording that is transcribed', () => {
  it('is sent to the first model that may take a visitor\'s audio, and answered in the gateway\'s own shape', async () => {
    gw.providers.alpha.enqueue({ kind: 'json', body: groqTranscription(SPEECH) })
    const recording = wav(5)

    const response = await transcribe(transcriptionParts(recording, [
      { name: 'language', value: 'en' },
      { name: 'prompt', value: 'a prompt the gateway must not forward' },
      { name: 'timestamp_granularities[]', value: 'word' },
      { name: 'temperature', value: '1' },
    ]))

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      task: 'transcribe',
      language: 'English',
      duration: 5,
      text: `Good morning, everyone. ${WORDS}`,
      segments: [
        { id: 0, start: 0, end: 2.4, text: 'Good morning, everyone.', avg_logprob: -0.2, no_speech_prob: 0.01 },
        { id: 1, start: 2.4, end: 5, text: WORDS, avg_logprob: -0.2, no_speech_prob: 0.01 },
      ],
    })
    expect(response.headers['x-lb-provider']).toBe('alpha')
    expect(response.headers['x-lb-model']).toBe('alpha/whisper')
    expect(response.headers['x-lb-attempts']).toBe('1')
    expect(response.headers['cache-control']).toBe('no-store')

    // The model that trains on inputs was never asked, and what alpha got is exactly the recording.
    expect(received()).toEqual([1, 0, 0, 0])
    const [sent] = gw.providers.alpha.requests
    expect(sent?.path).toBe('/v1/audio/transcriptions')
    expect(sent?.headers.authorization).toBe('Bearer alpha-key')
    expect(sent?.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    expect(sent?.form).toEqual({
      fields: { model: 'alpha/whisper-model', response_format: 'verbose_json', temperature: '0', language: 'en' },
      file: { name: 'recording.wav', type: 'audio/wav', size: recording.length, sha256: sha256(recording) },
    })
  })

  it('moves to Workers AI\'s own endpoint when the first provider fails, sending the audio in base64', async () => {
    gw.providers.alpha.enqueue({ kind: 'json', status: 503, body: { error: { message: 'overloaded' } } })
    gw.providers.beta.enqueue({ kind: 'json', body: workersTranscription(SPEECH) })
    const recording = wav(5)

    const response = await transcribe(transcriptionParts(recording))

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-lb-model']).toBe('beta/whisper')
    expect(response.headers['x-lb-attempts']).toBe('2')
    expect(response.json()).toMatchObject({ language: 'en', duration: 5, text: `Good morning, everyone. ${WORDS}` })
    const [sent] = gw.providers.beta.requests
    expect(sent?.path).toBe('/ai/run/@beta/whisper-model')
    expect(sent?.headers.authorization).toBe('Bearer beta-key')
    expect(sent?.body).toEqual({ audio: recording.toString('base64'), task: 'transcribe' })
  })

  it('tries the next model when an answer is not a transcription, or its times make no sense', async () => {
    gw.providers.alpha.enqueue({ kind: 'json', body: groqTranscription([[3, 1, 'Backwards.']]) })
    gw.providers.beta.enqueue({ kind: 'json', body: workersTranscription(SPEECH) })

    const response = await transcribe(transcriptionParts(wav(5)))

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-lb-model']).toBe('beta/whisper')
  })

  it('answers 502 when every model that may take the audio fails, having asked only those', async () => {
    gw.providers.alpha.setDefault({ kind: 'json', status: 500, body: {} })
    gw.providers.beta.setDefault({ kind: 'json', status: 500, body: {} })

    const response = await transcribe(transcriptionParts(wav(5)))

    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({ error: { code: 'upstream_failed' } })
    expect(received()).toEqual([1, 1, 0, 0])
  })

  it('passes on a provider\'s refusal of the audio itself, which no other model would take better', async () => {
    gw.providers.alpha.enqueue({ kind: 'json', status: 400, body: { error: { message: 'could not process file' } } })

    const response = await transcribe(transcriptionParts(wav(5)))

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'upstream_rejected' } })
    expect(received()).toEqual([1, 0, 0, 0])
  })
})

describe('who may send audio, and whose audio goes where', () => {
  it('sends a visitor\'s audio only to providers that do not train on inputs', async () => {
    gw.providers.alpha.setDefault({ kind: 'json', status: 500, body: {} })
    gw.providers.beta.setDefault({ kind: 'json', status: 500, body: {} })
    gw.providers.gamma.setDefault({ kind: 'json', body: groqTranscription(SPEECH) })

    const refused = await transcribe(transcriptionParts(wav(5)))

    // Gamma would have answered, and may not be asked.
    expect(refused.statusCode).toBe(502)
    expect(gw.providers.gamma.requests).toHaveLength(0)
  })

  it('lets the site\'s own synthetic recordings use the whole chain, the model that trains on inputs first', async () => {
    gw.providers.gamma.enqueue({ kind: 'json', body: groqTranscription(SPEECH) })

    const response = await transcribe(transcriptionParts(wav(5)), { 'x-lb-data-class': 'synthetic', 'x-lb-session': undefined })

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-lb-model']).toBe('gamma/whisper')
    expect(gw.providers.gamma.requests[0]?.headers.authorization).toBe('Bearer gamma-key')
  })

  it('asks a visitor\'s call for a session, so the visitor\'s own quota applies', async () => {
    const response = await transcribe(transcriptionParts(wav(5)), { 'x-lb-session': undefined })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request', message: expect.stringContaining('x-lb-session') } })
    expect(received()).toEqual([0, 0, 0, 0])
  })

  it('refuses a service that does not own the system, a system that does not list the alias, and a service that only reads traces', async () => {
    const parts = transcriptionParts(wav(5))
    const stranger = await transcribe(parts, { authorization: `Bearer ${await gw.token('flask-systems')}` })
    expect(stranger.statusCode).toBe(403)
    expect(stranger.json()).toMatchObject({ error: { code: 'system_not_allowed', type: 'permission_error' } })

    const noAlias = await transcribe(parts, { 'x-lb-system': 'lb-01' })
    expect(noAlias.statusCode).toBe(403)
    expect(noAlias.json()).toMatchObject({ error: { code: 'alias_not_allowed' } })

    const otherService = await transcribe(parts, { 'authorization': `Bearer ${await gw.token('flask-systems')}`, 'x-lb-system': 'lb-05' })
    expect(otherService.statusCode).toBe(403)
    expect(otherService.json()).toMatchObject({ error: { code: 'alias_not_allowed' } })

    const reader = await transcribe(parts, { authorization: `Bearer ${await gw.token('web')}` })
    expect(reader.statusCode).toBe(403)
    expect(reader.json()).toMatchObject({ error: { code: 'system_not_allowed' } })
    expect(received()).toEqual([0, 0, 0, 0])
  })

  it('needs a service token', async () => {
    const response = await transcribe(transcriptionParts(wav(5)), { authorization: undefined })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { code: 'invalid_service_token' } })
  })

  it('keeps speech aliases on this route and chat aliases on theirs', async () => {
    const chatAlias = await transcribe(transcriptionParts(wav(5), [], 'lb-fast'))
    expect(chatAlias.statusCode).toBe(404)
    expect(chatAlias.json()).toMatchObject({ error: { code: 'model_not_found' } })

    const asChat = await gw.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: await gw.headers({ 'x-lb-system': 'lb-09' }), payload: chatBody({ model: 'lb-stt' }) })
    expect(asChat.statusCode).toBe(404)

    const unknown = await transcribe(transcriptionParts(wav(5), [], 'whisper-1'))
    expect(unknown.statusCode).toBe(404)
  })

  it('takes a multipart body on this route only', async () => {
    const { payload, contentType } = await multipart([{ name: 'model', value: 'lb-fast' }])

    const response = await gw.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { ...(await gw.headers()), 'content-type': contentType }, payload })

    expect(response.statusCode).toBe(415)
  })
})

describe('what is measured, and refused, before anything is spent', () => {
  it('refuses a recording longer than the alias allows, measured from its bytes, and charges nothing', async () => {
    const response = await transcribe(transcriptionParts(wav(30.2)))

    expect(response.statusCode).toBe(413)
    expect(response.json()).toMatchObject({ error: { code: 'input_too_large', message: expect.stringContaining('30.2 seconds') } })
    expect(received()).toEqual([0, 0, 0, 0])
    expect(await meter('system:lb-09', 'requests', 'day')).toMatchObject({ used: 0 })
  })

  it('takes a recording of exactly the longest length', async () => {
    gw.providers.alpha.enqueue({ kind: 'json', body: groqTranscription(SPEECH) })

    const response = await transcribe(transcriptionParts(wav(30)))

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ duration: 30 })
  })

  it('refuses a request body past what the longest recording could need, with the same status', async () => {
    const response = await transcribe(transcriptionParts(wav(60)))

    expect(response.statusCode).toBe(413)
    expect(response.json()).toMatchObject({ error: { code: 'input_too_large' } })
    expect(received()).toEqual([0, 0, 0, 0])
  })

  it('refuses a header that claims a shorter recording than the file holds, since the bytes decide', async () => {
    const lying = Buffer.concat([wavHeader(1_200_000), Buffer.alloc(100)])
    const response = await transcribe(transcriptionParts(lying))

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { message: expect.stringContaining('does not match the size of the file') } })
  })

  it('refuses audio that is not 16-bit mono 16 kHz WAV, and a recording with nothing in it', async () => {
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200)])
    expect((await transcribe(transcriptionParts(mp3))).statusCode).toBe(400)

    const stereo = Buffer.concat([wavHeader(64_000, { channels: 2 }), Buffer.alloc(64_000)])
    const stereoAnswer = await transcribe(transcriptionParts(stereo))
    expect(stereoAnswer.statusCode).toBe(400)
    expect(stereoAnswer.json()).toMatchObject({ error: { message: expect.stringContaining('16-bit PCM, mono, at 16 kHz') } })

    const blip = Buffer.concat([wavHeader(1_000), Buffer.alloc(1_000)])
    const short = await transcribe(transcriptionParts(blip))
    expect(short.statusCode).toBe(400)
    expect(short.json()).toMatchObject({ error: { message: expect.stringContaining('too short') } })
    expect(received()).toEqual([0, 0, 0, 0])
  })

  it('refuses a form that is not what an OpenAI client sends', async () => {
    const recording = wav(5)
    const forms: [string, Part[]][] = [
      ['no file', [{ name: 'model', value: 'lb-stt' }]],
      ['no model', [{ name: 'file', file: recording }]],
      ['a format other than verbose_json', transcriptionParts(recording).map(part => part.name === 'response_format' ? { name: 'response_format', value: 'text' } : part)],
      ['a language that is not a code', transcriptionParts(recording, [{ name: 'language', value: 'English' }])],
      ['a repeated field', transcriptionParts(recording, [{ name: 'model', value: 'lb-stt' }])],
      ['two files', [...transcriptionParts(recording), { name: 'file', file: recording }]],
      ['a file under another name', [{ name: 'model', value: 'lb-stt' }, { name: 'audio', file: recording }]],
      ['text under the name of the file', [{ name: 'model', value: 'lb-stt' }, { name: 'file', value: 'not a file' }]],
    ]
    for (const [name, parts] of forms) {
      const response = await transcribe(parts)
      expect(response.statusCode, name).toBe(400)
      expect(response.json(), name).toMatchObject({ error: { code: 'invalid_request' } })
    }
    expect(received()).toEqual([0, 0, 0, 0])
  })

  it('refuses a body that is not valid multipart, and a JSON body', async () => {
    const call = await gw.headers({ 'x-lb-system': 'lb-09' })
    const garbled = await gw.app.inject({ method: 'POST', url: '/v1/audio/transcriptions', headers: { ...call, 'content-type': 'multipart/form-data; boundary=xyz' }, payload: 'this is not a form' })
    expect(garbled.statusCode).toBe(400)
    expect(garbled.json()).toMatchObject({ error: { code: 'invalid_request' } })

    const json = await gw.app.inject({ method: 'POST', url: '/v1/audio/transcriptions', headers: { ...call, 'content-type': 'application/json' }, payload: { model: 'lb-stt' } })
    expect(json.statusCode).toBe(415)
    expect(json.json()).toMatchObject({ error: { code: 'invalid_request' } })
  })

  it('refuses a form with more parts than any request needs', async () => {
    const extras: Part[] = Array.from({ length: 20 }, (_, index) => ({ name: `extra${index}`, value: 'x' }))

    const response = await transcribe(transcriptionParts(wav(5), extras))

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { message: expect.stringContaining('too many parts') } })
  })
})

describe('budgets in seconds of audio', () => {
  // The clock stands still, so a window never slides between two calls of a test.
  beforeEach(async () => {
    await gw.close()
    gw = await startGateway({ frozenClock: true })
  })

  it('counts the seconds a recording holds, at least ten, against the hour and the day', async () => {
    gw.providers.alpha.setDefault({ kind: 'json', body: groqTranscription(SPEECH) })

    await transcribe(transcriptionParts(wav(5)))
    await transcribe(transcriptionParts(wav(12)))

    // A recording of five seconds is billed ten; one of twelve is billed twelve.
    expect(await meter('model:alpha/whisper', 'audioSeconds', 'hour')).toMatchObject({ used: 22, limit: 120 })
    expect(await meter('model:alpha/whisper', 'audioSeconds', 'day')).toMatchObject({ used: 22, limit: 600 })
    expect(await meter('model:alpha/whisper', 'requests', 'day')).toMatchObject({ used: 2, limit: 100 })
    expect(await meter('system:lb-09', 'requests', 'day')).toMatchObject({ used: 2 })
  })

  it('counts Neurons by the minute of audio when Workers AI serves the call', async () => {
    gw.providers.alpha.enqueue({ kind: 'json', status: 500, body: {} })
    gw.providers.beta.enqueue({ kind: 'json', body: workersTranscription(SPEECH) })

    await transcribe(transcriptionParts(wav(30)))

    // 30 seconds at 30 Neurons a minute.
    expect(await meter('provider:beta', 'neurons', 'day')).toMatchObject({ used: 15, limit: 10_000 })
  })

  it('answers budget_exhausted once the day\'s seconds are spent, and the visitor is charged nothing for it', async () => {
    gw.providers.alpha.setDefault({ kind: 'json', body: groqTranscription(SPEECH) })
    const ask = () => transcribe(transcriptionParts(wav(3), [], 'lb-stt-day'))

    expect((await ask()).statusCode).toBe(200)
    expect((await ask()).statusCode).toBe(200)
    const spent = await ask()

    expect(spent.statusCode).toBe(503)
    expect(spent.json()).toMatchObject({ error: { code: 'budget_exhausted', message: expect.stringContaining('Serve a replay') } })
    expect(Number(spent.headers['retry-after'])).toBeGreaterThan(0)
    expect(gw.providers.alpha.requests).toHaveLength(2)
    expect(await meter('system:lb-09', 'requests', 'day')).toMatchObject({ used: 2 })
  })

  it('holds the hour limit on its own, with Retry-After no longer than an hour', async () => {
    gw.providers.alpha.setDefault({ kind: 'json', body: groqTranscription(SPEECH) })
    const ask = () => transcribe(transcriptionParts(wav(3), [], 'lb-stt-hour'))

    expect((await ask()).statusCode).toBe(200)
    expect((await ask()).statusCode).toBe(200)
    const spent = await ask()

    expect(spent.statusCode).toBe(503)
    expect(spent.json()).toMatchObject({ error: { code: 'budget_exhausted' } })
    expect(Number(spent.headers['retry-after'])).toBeLessThanOrEqual(3600)
  })

  it('caps the calls of one run, whatever kind they are', async () => {
    gw.providers.alpha.setDefault({ kind: 'json', body: groqTranscription(SPEECH) })
    const run = { 'x-lb-run-id': 'run-capped-audio-01' }
    for (let call = 0; call < 4; call += 1) expect((await transcribe(transcriptionParts(wav(5)), run)).statusCode).toBe(200)

    const capped = await transcribe(transcriptionParts(wav(5)), run)

    expect(capped.statusCode).toBe(429)
    expect(capped.json()).toMatchObject({ error: { code: 'quota_exceeded' } })
  })
})

describe('what the trace and the log hold', () => {
  it('records a span of numbers and names: the seconds, the segments and the model, never the audio or the words', async () => {
    gw.providers.alpha.enqueue({ kind: 'json', body: groqTranscription(SPEECH) })
    const runId = 'run-audio-spans-0001'

    await transcribe(transcriptionParts(wav(5)), { 'x-lb-run-id': runId })

    const spans = await gw.runSpans(runId)
    const call = spans.find(span => span.kind === 'gateway.call')
    expect(call).toMatchObject({ name: 'lb-stt', status: 'ok', system: 'lb-09', attrs: { alias: 'lb-stt', dataClass: 'visitor', attempts: 1, audioSeconds: 5, segments: 2, model: 'alpha/whisper' } })
    const skipped = spans.find(span => span.kind === 'gateway.attempt' && span.status === 'skipped')
    expect(skipped).toMatchObject({ name: 'gamma/whisper', attrs: { outcome: 'visitor-data' } })
    const written = JSON.stringify(spans)
    expect(written).not.toContain('Marta')
    expect(written).not.toContain('Colombian')
    expect(written).not.toContain(wav(5).subarray(100, 200).toString('base64'))
  })

  it('records the failure of an attempt as a span too', async () => {
    gw.providers.alpha.enqueue({ kind: 'json', status: 503, body: {} })
    gw.providers.beta.enqueue({ kind: 'json', body: workersTranscription(SPEECH) })
    const runId = 'run-audio-spans-0002'

    await transcribe(transcriptionParts(wav(5)), { 'x-lb-run-id': runId })

    const outcomes = (await gw.runSpans(runId)).filter(span => span.kind === 'gateway.attempt').map(span => [span.name, span.status])
    expect(outcomes).toEqual([['gamma/whisper', 'skipped'], ['alpha/whisper', 'error'], ['beta/whisper', 'ok']])
  })
})

describe('what the request log holds', () => {
  let lines: string[]
  let logged: TestGateway

  beforeEach(async () => {
    lines = []
    logged = await startGateway({ logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) } } })
  })

  afterEach(async () => {
    await logged.close()
  })

  it('has no word of the audio, none of the recording and no key', async () => {
    logged.providers.alpha.enqueue({ kind: 'json', body: groqTranscription(SPEECH) })
    const { payload, contentType } = await multipart(transcriptionParts(wav(5)))
    const call = await logged.headers({ 'x-lb-system': 'lb-09' })

    const response = await logged.app.inject({ method: 'POST', url: '/v1/audio/transcriptions', headers: { ...call, 'content-type': contentType }, payload })

    expect(response.statusCode).toBe(200)
    const written = lines.join('')
    expect(written.length).toBeGreaterThan(0)
    for (const secret of ['Marta', 'Colombian', 'alpha-key', 'session-0123456789abcdef', wav(5).subarray(100, 200).toString('base64')]) {
      expect(written).not.toContain(secret)
    }
  })
})
