// Makes `shared/data/samples/lb09.ts`, the curated meetings LB-09's demo opens on, from the golden
// set's cases marked `sample: true` (evals/lb09/golden.yaml), the scripts they point to
// (data/seed/lb09/<key>.yaml) and the manifest of the committed audio (data/seed/lb09/audio/manifest.yaml).
// It also copies each sample's audio file into `public/lb09/`, so the page plays the very recording the
// back end transcribes. One source means the demo shows exactly what the evals check, and a sample cannot
// be added to the demo without being graded.
//
//   node scripts/samples-lb09.ts            write the files (`pnpm --filter @lb/web samples`)
//   node scripts/samples-lb09.ts --check    fail when a file is stale (`pnpm check`, which CI runs)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { z } from 'zod'

/** Resolves a path relative to this script's folder. */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

const GOLDEN_FILE = here('../../../evals/lb09/golden.yaml')
const SCRIPTS_DIR = here('../../../data/seed/lb09/')
const AUDIO_DIR = here('../../../data/seed/lb09/audio/')
const OUTPUT_FILE = here('../shared/data/samples/lb09.ts')
const PUBLIC_DIR = here('../public/lb09/')

const KEY = z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/)

// The part of a golden case the demo needs: which meeting it is, whether it is a sample, and what it plants.
const goldenSchema = z.object({
  cases: z.array(z.object({
    id: KEY,
    meeting: KEY,
    sample: z.boolean().optional(),
    expect: z.object({
      decisions: z.array(z.object({ id: KEY })),
      actions: z.array(z.object({ id: KEY })),
    }),
  })).min(1),
})

// The part of a script the demo needs.
const scriptSchema = z.object({
  key: KEY,
  title: z.string().min(3).max(60),
  language: z.enum(['en', 'cs']),
  about: z.string().trim().min(10).max(300),
  speakers: z.array(z.object({ id: KEY })).min(2),
})

// The manifest of the committed audio: each meeting's file and its decoded length.
const manifestSchema = z.object({
  meetings: z.record(KEY, z.object({
    file: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\.mp3$/),
    bytes: z.int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    seconds: z.number().positive().max(60),
  })),
})

/** One sample as the demo holds it. */
interface Sample {
  id: string
  goldenCase: string
  language: 'en' | 'cs'
  title: string
  about: string
  file: string
  seconds: number
  speakers: number
  decisions: number
  actions: number
}

/** Collapses a folded text onto one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Reads the golden set, the scripts and the manifest, and returns the samples in the golden set's order. */
function readSamples(): Sample[] {
  const golden = goldenSchema.parse(parse(readFileSync(GOLDEN_FILE, 'utf8')))
  const manifest = manifestSchema.parse(parse(readFileSync(`${AUDIO_DIR}manifest.yaml`, 'utf8')))
  const problems: string[] = []
  const samples = golden.cases.filter(item => item.sample === true).flatMap((item): Sample[] => {
    const scriptPath = `${SCRIPTS_DIR}${item.meeting}.yaml`
    if (!existsSync(scriptPath)) {
      problems.push(`The golden case ${item.id} names the meeting ${item.meeting}, which has no script.`)
      return []
    }
    const script = scriptSchema.parse(parse(readFileSync(scriptPath, 'utf8')))
    const audio = manifest.meetings[item.meeting]
    if (!audio) {
      problems.push(`The meeting ${item.meeting} has no audio in the manifest: run \`just tts-lb09\`.`)
      return []
    }
    return [{
      id: item.meeting,
      goldenCase: item.id,
      language: script.language,
      title: script.title,
      about: oneLine(script.about),
      file: audio.file,
      seconds: audio.seconds,
      speakers: script.speakers.length,
      decisions: item.expect.decisions.length,
      actions: item.expect.actions.length,
    }]
  })
  if (problems.length > 0) throw new Error(problems.join('\n'))
  return samples
}

/** Writes text as a TypeScript string literal in the project's style: single quotes, with the text's own escaped. */
function quote(text: string): string {
  return `'${text.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}'`
}

/** Writes one sample as an object literal, one field to a line. */
function renderSample(sample: Sample): string {
  return [
    '  {',
    `    id: ${quote(sample.id)},`,
    `    goldenCase: ${quote(sample.goldenCase)},`,
    `    language: ${quote(sample.language)},`,
    `    title: ${quote(sample.title)},`,
    `    about: ${quote(sample.about)},`,
    `    file: ${quote(sample.file)},`,
    `    seconds: ${sample.seconds},`,
    `    speakers: ${sample.speakers},`,
    `    decisions: ${sample.decisions},`,
    `    actions: ${sample.actions},`,
    '  },',
  ].join('\n')
}

/** Writes the whole file: its header, the samples and the type of their IDs. */
function renderFile(samples: readonly Sample[]): string {
  return [
    '// GENERATED by scripts/samples-lb09.ts from the cases marked `sample: true` in evals/lb09/golden.yaml, the',
    '// scripts in data/seed/lb09 and the manifest of their committed audio.',
    '// Do not edit it by hand: change those files and run `pnpm --filter @lb/web samples`.',
    '// `pnpm check` fails when this file is out of date.',
    'import type { MeetingSample } from \'./lb09-types\'',
    '',
    '/** The curated meetings LB-09\'s demo opens on, in the golden set\'s order. */',
    'export const LB09_SAMPLES = [',
    ...samples.map(renderSample),
    '] as const satisfies readonly MeetingSample[]',
    '',
    '/** The ID of one of LB-09\'s samples, such as `monday-roasting-plan`. */',
    'export type Lb09SampleId = (typeof LB09_SAMPLES)[number][\'id\']',
    '',
  ].join('\n')
}

/** Says whether a public audio file is the committed one, byte for byte. */
function audioIsCurrent(file: string): boolean {
  const target = `${PUBLIC_DIR}${file}`
  return existsSync(target) && readFileSync(target).equals(readFileSync(`${AUDIO_DIR}${file}`))
}

const samples = readSamples()
const rendered = renderFile(samples)
const staleAudio = samples.filter(sample => !audioIsCurrent(sample.file)).map(sample => sample.file)

if (process.argv.includes('--check')) {
  const current = existsSync(OUTPUT_FILE) ? readFileSync(OUTPUT_FILE, 'utf8') : ''
  if (current !== rendered || staleAudio.length > 0) {
    console.error('shared/data/samples/lb09.ts or public/lb09/ is out of date: run `pnpm --filter @lb/web samples`.')
    process.exit(1)
  }
  console.log('shared/data/samples/lb09.ts and public/lb09/ are up to date.')
}
else {
  writeFileSync(OUTPUT_FILE, rendered)
  mkdirSync(PUBLIC_DIR, { recursive: true })
  for (const sample of samples) writeFileSync(`${PUBLIC_DIR}${sample.file}`, readFileSync(`${AUDIO_DIR}${sample.file}`))
  console.log(`Wrote ${samples.length} samples to shared/data/samples/lb09.ts and their audio to public/lb09/.`)
}
