// POST /v1/audio/transcriptions: speech to text, in the OpenAI multipart shape. The caller
// sends a recording as a WAV file (16-bit PCM, mono, 16 kHz: src/audio/wav.ts says why) and
// gets back the words with the second each stretch of speech starts and ends. Like every
// other route it checks the caller, the alias and the size before it spends anything, walks
// the alias's chain with fallback, and records a span of numbers and names, never of audio
// or words. What differs is the measure: a recording has no tokens, so its quotas and
// budgets count seconds of audio, read from the bytes and not from anything the caller says.
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { readTranscript } from '../audio/transcript.ts'
import { BYTES_PER_SECOND, readWav, WAV_HEADER_BYTES, WavError } from '../audio/wav.ts'
import { audioAttempt, watchClient } from '../attempts.ts'
import { assertPlannable, ModelCall, readCallMeta, resolveAlias } from '../call.ts'
import type { GatewayContext } from '../call.ts'
import { GatewayError } from '../errors.ts'
import type { Alias, Routing } from '../routing/load.ts'
import { planChain } from '../routing/plan.ts'
import type { Capability } from '../routing/schema.ts'
import { transcriptionFieldsSchema } from '../schemas/transcription.ts'
import { parseBody } from './body.ts'

const KIB = 1_024
// A provider's answer is a few kilobytes of segments; anything near this is not one.
const MAX_TRANSCRIPTION_BYTES = 1_048_576
// The multipart framing around the file and the few small fields beside it.
const FORM_OVERHEAD_BYTES = 16 * KIB
// A form with more parts than this is not a transcription request.
const MAX_FORM_PARTS = 16
// Groq bills at least this many seconds a request, and the budget counts what the provider counts.
const MIN_BILLED_SECONDS = 10
// A recording shorter than this has no speech to find.
const MIN_AUDIO_SECONDS = 0.1
const needs: ReadonlySet<Capability> = new Set(['transcription'])

/** The request body the route reads, in bytes: the longest recording any alias allows, plus the form around it. */
export function bodyLimitFor(routing: Routing): number {
  const seconds = [...routing.aliases.values()].map(alias => alias.maxAudioSeconds ?? 0)
  return Math.ceil(Math.max(0, ...seconds) * BYTES_PER_SECOND) + WAV_HEADER_BYTES + FORM_OVERHEAD_BYTES
}

/** The seconds of audio a call is billed for: what the recording holds, and never less than the provider's minimum. */
export function billedSeconds(seconds: number): number {
  return Math.max(MIN_BILLED_SECONDS, Math.ceil(seconds))
}

/** The parts of a transcription form: its text fields by name, and the one file. */
interface Form {
  fields: Map<string, string>
  file: File | undefined
}

/**
 * Reads the multipart body the content-type parser handed over. A body that is not valid
 * multipart, a name that repeats, a file that is not called `file`, or too many parts is
 * the caller's mistake (400).
 */
async function readForm(request: FastifyRequest): Promise<Form> {
  const type = request.headers['content-type'] ?? ''
  // The route's own parser hands over a buffer; any other kind of body (JSON, say) is not a form.
  if (!Buffer.isBuffer(request.body)) throw new GatewayError(415, 'invalid_request', 'Send the request as multipart/form-data.')
  let data: FormData
  try {
    data = await new Response(request.body, { headers: { 'content-type': type } }).formData()
  }
  catch {
    throw new GatewayError(400, 'invalid_request', 'The body is not valid multipart/form-data.')
  }
  const form: Form = { fields: new Map(), file: undefined }
  let parts = 0
  for (const [name, value] of data.entries()) {
    parts += 1
    if (parts > MAX_FORM_PARTS) throw new GatewayError(400, 'invalid_request', 'The form has too many parts.')
    if (name === 'file' && typeof value !== 'string' && !form.file) {
      form.file = value
    }
    else if (name !== 'file' && typeof value === 'string' && !form.fields.has(name)) {
      form.fields.set(name, value)
    }
    else {
      throw new GatewayError(400, 'invalid_request', 'The form repeats a field, sends two files, or sends a file under a name that is not "file".')
    }
  }
  return form
}

/**
 * Reads the recording, which must be the WAV the gateway takes, and measures it. The
 * caller learns what is wrong with the file (400), or that it is longer than the alias
 * allows (413); neither costs a quota.
 */
async function measure(file: File | undefined, alias: Alias): Promise<{ wav: Uint8Array, seconds: number }> {
  if (!file) throw new GatewayError(400, 'invalid_request', 'Send the recording as the "file" part of the form.')
  const wav = new Uint8Array(await file.arrayBuffer())
  let seconds: number
  try {
    seconds = readWav(wav).seconds
  }
  catch (error) {
    if (error instanceof WavError) throw new GatewayError(400, 'invalid_request', error.message)
    throw error
  }
  if (seconds < MIN_AUDIO_SECONDS) throw new GatewayError(400, 'invalid_request', 'The recording is too short to hold speech.')
  if (seconds > (alias.maxAudioSeconds ?? 0)) {
    throw new GatewayError(413, 'input_too_large', `The recording is ${seconds.toFixed(1)} seconds long; ${alias.name} takes up to ${alias.maxAudioSeconds} seconds.`)
  }
  return { wav, seconds }
}

/** Registers the transcription route on the /v1 scope. */
export async function registerTranscriptions(app: FastifyInstance, ctx: GatewayContext): Promise<void> {
  const limit = bodyLimitFor(ctx.routing)
  // A scope of its own, so that only this route accepts a multipart body: every other
  // route still answers 415 to one.
  await app.register(async (scope) => {
    scope.addContentTypeParser('multipart/form-data', { parseAs: 'buffer', bodyLimit: limit }, (_request, body, done) => {
      done(null, body)
    })
    scope.post('/audio/transcriptions', { bodyLimit: limit }, async (request, reply) => {
      // 1. Check everything before spending anything: headers, form, alias, recording.
      const meta = readCallMeta(request, ctx.routing)
      const form = await readForm(request)
      const fields = parseBody(transcriptionFieldsSchema, Object.fromEntries(form.fields))
      const alias = resolveAlias(ctx.routing, meta.system, fields.model, 'transcription')
      const { wav, seconds } = await measure(form.file, alias)
      const plan = planChain(alias, meta.dataClass, ctx.profile, needs)
      assertPlannable(plan, alias, needs)

      // 2. Count the call, then let the chain's models try. The budget is in the seconds
      //    the recording holds; the provider reports no usage, so the estimate stands.
      const call = new ModelCall(ctx, meta, alias, plan, { input: 0, output: 0, audioSeconds: billedSeconds(seconds) }, false)
      await call.admit()
      const served = await call.run(audioAttempt(
        { wav, language: fields.language },
        (json, model) => readTranscript(json, model, seconds),
        MAX_TRANSCRIPTION_BYTES,
        watchClient(reply.raw),
        ctx.now,
      ))

      // 3. The span says how long the recording was and how many stretches of speech it
      //    held: numbers only.
      await call.finish(served, undefined, { ok: true, attrs: { audioSeconds: Math.round(seconds * 100) / 100, segments: served.value.parsed.segments.length } })
      return reply.headers(call.headers(served.model)).send(served.value.parsed)
    })
  })
}
