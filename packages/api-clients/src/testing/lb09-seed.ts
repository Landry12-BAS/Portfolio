// The data the mock back end's LB-09 draws on, read from the files the real service is seeded and
// graded from: the scripted meetings (data/seed/lb09/<key>.yaml), the golden set that says what each
// one holds (evals/lb09/golden.yaml) and the manifest of the committed audio with each turn's timing
// (data/seed/lb09/audio/manifest.yaml). From them the mock builds what a pipeline that does exactly
// what the golden set expects would find: the labelled transcript, one segment a turn, and every
// planted decision and action with its quote and the seconds of the turns it is said in. So the
// mock's samples are the real ones, and nothing about them is written out a second time.
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'

const KEY = z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/)

// A script: who speaks and what they say, in order.
const scriptSchema = z.object({
  key: KEY,
  title: z.string().min(3).max(60),
  language: z.enum(['en', 'cs']),
  about: z.string().trim().min(10).max(300),
  speakers: z.array(z.object({ id: KEY, name: z.string().min(2).max(20) })).min(2),
  turns: z.array(z.object({ speaker: KEY, text: z.string().min(1).max(300) })).min(4),
})

// An expected item: the turns it is said in, a quote from them, and for an action its owner and deadline.
const expectedItemSchema = z.object({
  id: KEY,
  summary: z.string().min(5).max(120),
  said_in: z.array(z.int().nonnegative()).min(1),
  quote: z.string().min(10).max(300),
})
const expectedActionSchema = expectedItemSchema.extend({
  owner: z.union([z.string(), z.array(z.string()).min(1)]).nullable(),
  deadline: z.string().nullable(),
})
const goldenSchema = z.object({
  cases: z.array(z.object({
    id: KEY,
    meeting: KEY,
    sample: z.boolean().optional(),
    expect: z.object({
      introduced: z.array(KEY),
      decisions: z.array(expectedItemSchema),
      actions: z.array(expectedActionSchema),
    }),
  })).min(1),
})

// The manifest: each meeting's audio file, its decoded length, and when each turn is spoken.
const manifestSchema = z.object({
  meetings: z.record(KEY, z.object({
    file: z.string(),
    seconds: z.number().positive(),
    turns: z.array(z.object({ start: z.number().nonnegative(), end: z.number().positive() })).min(1),
  })),
})

/** One stretch of speech as the mock answers it, with the speaker the words suggest. */
export interface SeedSegment {
  position: number
  start: number
  end: number
  text: string
  speaker: number
  label: string
}

/** One decision or action as the mock answers it, with its quote and the seconds derived from the turns. */
export interface SeedItem {
  position: number
  kind: 'decision' | 'action'
  text: string
  owner: string | null
  deadline: string | null
  evidence: string
  start: number
  end: number
  first_segment: number
  last_segment: number
}

/** One curated meeting: what the API lists about it, and what the pipeline finds in it. */
export interface Lb09SampleSeed {
  key: string
  title: string
  about: string
  file: string
  seconds: number
  speakers: number
  segments: SeedSegment[]
  items: SeedItem[]
}

/** Everything the mock reads for LB-09. */
export interface Lb09Seed {
  samples: Lb09SampleSeed[]
}

/** The root of the repository, from this file. */
const ROOT = resolve(import.meta.dirname, '../../../..')

/** The label each speaker gets: their name if they say it, else "Speaker N" by order of first word, as the real labelling does. */
function expectedLabels(script: z.infer<typeof scriptSchema>, introduced: readonly string[]): Map<string, { index: number, label: string }> {
  const labels = new Map<string, { index: number, label: string }>()
  let unnamed = 0
  for (const turn of script.turns) {
    if (labels.has(turn.speaker)) continue
    const named = introduced.includes(turn.speaker)
    const name = script.speakers.find(speaker => speaker.id === turn.speaker)?.name ?? turn.speaker
    if (!named) unnamed += 1
    labels.set(turn.speaker, { index: labels.size, label: named ? name : `Speaker ${unnamed}` })
  }
  return labels
}

/** The first owner the golden set accepts, or none. */
function firstOwner(owner: string | string[] | null): string | null {
  if (owner === null) return null
  return Array.isArray(owner) ? (owner[0] ?? null) : owner
}

/** Builds what a perfect pipeline finds in a sample: the labelled transcript and the planted items, placed by the audio's timeline. */
function buildSample(golden: z.infer<typeof goldenSchema>['cases'][number], script: z.infer<typeof scriptSchema>, audio: z.infer<typeof manifestSchema>['meetings'][string]): Lb09SampleSeed {
  const labels = expectedLabels(script, golden.expect.introduced)
  const segments: SeedSegment[] = script.turns.map((turn, position) => {
    const timing = audio.turns[position] ?? { start: 0, end: 0 }
    const who = labels.get(turn.speaker) ?? { index: 0, label: 'Speaker 1' }
    return { position, start: timing.start, end: timing.end, text: turn.text, speaker: who.index, label: who.label }
  })
  const placed = (saidIn: number[]) => {
    const spans = saidIn.map(turn => audio.turns[turn] ?? { start: 0, end: 0 })
    return { start: Math.min(...spans.map(span => span.start)), end: Math.max(...spans.map(span => span.end)), first_segment: Math.min(...saidIn), last_segment: Math.max(...saidIn) }
  }
  const items: SeedItem[] = [
    ...golden.expect.decisions.map(item => ({ kind: 'decision' as const, text: item.summary, owner: null, deadline: null, evidence: item.quote, ...placed(item.said_in) })),
    ...golden.expect.actions.map(item => ({ kind: 'action' as const, text: item.summary, owner: firstOwner(item.owner), deadline: item.deadline, evidence: item.quote, ...placed(item.said_in) })),
  ].map((item, position) => ({ position, ...item }))
  return { key: script.key, title: script.title, about: script.about.replace(/\s+/g, ' ').trim(), file: audio.file, seconds: audio.seconds, speakers: script.speakers.length, segments, items }
}

/** Reads the scripts, the golden set and the manifest, and builds the curated samples in the golden set's order. */
export function readLb09Seed(): Lb09Seed {
  const seedDir = resolve(ROOT, 'data/seed/lb09')
  const golden = goldenSchema.parse(parse(readFileSync(resolve(ROOT, 'evals/lb09/golden.yaml'), 'utf8')))
  const manifest = manifestSchema.parse(parse(readFileSync(resolve(seedDir, 'audio/manifest.yaml'), 'utf8')))
  const scripts = new Map(readdirSync(seedDir).filter(name => name.endsWith('.yaml')).map((name) => {
    const script = scriptSchema.parse(parse(readFileSync(resolve(seedDir, name), 'utf8')))
    return [script.key, script] as const
  }))
  const samples = golden.cases.filter(item => item.sample === true).map((item) => {
    const script = scripts.get(item.meeting)
    const audio = manifest.meetings[item.meeting]
    if (!script || !audio) throw new Error(`The golden case ${item.id} names the meeting ${item.meeting}, which has no script or no audio.`)
    return buildSample(item, script, audio)
  })
  return { samples }
}
