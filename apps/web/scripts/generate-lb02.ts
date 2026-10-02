// Makes the files of LB-02's board that come from somewhere else, so each has one source and the
// demo cannot drift from it:
//
//   shared/data/samples/lb02.ts     the curated conversations, from the golden set's `sample: true` cases
//   public/lb02-icon.svg            the app icon, a copy of the brand file (`brand/lb-icon-light.svg`)
//   public/lb02.en.webmanifest      the web app manifest of the installable board, one for each language,
//   public/lb02.cs.webmanifest      with its words taken from the board's locale modules
//   public/lb02-offline.en.html     the page the app's service worker shows when the board's page is not
//   public/lb02-offline.cs.html     on the device and there is no connection, with its words from the same modules
//
//   node scripts/generate-lb02.ts            write the files (`pnpm --filter @lb/web samples`)
//   node scripts/generate-lb02.ts --check    fail when one is stale (`pnpm check`, which CI runs)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'
import { z } from 'zod'

import cs from '../i18n/locales/boards/lb-02.cs.ts'
import en from '../i18n/locales/boards/lb-02.en.ts'
import { vlna } from '../shared/typography.ts'

/** Resolves a path relative to this script's folder. */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

const GOLDEN_FILE = here('../../../evals/lb02/golden.yaml')
const BRAND_ICON = here('../../../brand/lb-icon-light.svg')
const SAMPLES_FILE = here('../shared/data/samples/lb02.ts')
const ICON_FILE = here('../public/lb02-icon.svg')

// The board's address, in each language: where the installed app opens, and the part of the site it owns.
const BOARD_PATHS = { en: '/systems/lb-02', cs: '/cs/systems/lb-02' } as const
// A manifest cannot use the design tokens, so these repeat two of their light values:
// `--lb-desk` for the window's colour (as the site's theme-color meta does) and `--lb-sheet` for the splash screen.
const THEME_COLOR = '#eceff2'
const BACKGROUND_COLOR = '#ffffff'

// The part of a golden case the demo needs. Other fields (the references the grader checks) are ignored.
const goldenSchema = z.object({
  cases: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{1,60}$/),
    covers: z.array(z.string().regex(/^[a-z_]{1,40}$/)).min(1),
    // Cases that are not samples may be in any language; a sample must be one the site is in.
    language: z.string().regex(/^[a-z]{2}$/),
    sample: z.boolean().optional(),
    world: z.array(z.object({
      before_turn: z.int().min(1).max(30),
      other_visitor: z.enum(['holds', 'books']),
      slot: z.object({
        offering: z.string().regex(/^[a-z-]{1,40}$/),
        day: z.int().min(1).max(14),
        time: z.string().regex(/^\d{2}:\d{2}$/),
      }),
    })).optional(),
    turns: z.array(z.object({
      say: z.string().min(1).max(500),
      wait_minutes: z.int().min(0).max(60).optional(),
    })).min(1).max(30),
  })).min(1),
})

// The languages a sample may be written in.
const sampleLanguageSchema = z.enum(['en', 'cs'])

/** One file the script makes: where it goes and what is in it. */
interface Generated {
  file: string
  text: string
}

/** One sample as the demo holds it. */
interface Sample {
  id: string
  language: 'en' | 'cs'
  covers: string[]
  turns: { say: string, waitMinutes: number }[]
  world: { beforeTurn: number, otherVisitor: 'holds' | 'books', offering: string, day: number, time: string }[]
}

/** Reads the golden set and returns its curated cases, in file order. */
function readSamples(): Sample[] {
  const golden = goldenSchema.parse(parse(readFileSync(GOLDEN_FILE, 'utf8')))
  return golden.cases
    .filter(item => item.sample === true)
    .map(item => ({
      id: item.id,
      language: sampleLanguageSchema.parse(item.language),
      covers: item.covers,
      turns: item.turns.map(turn => ({ say: turn.say.replace(/\s+/g, ' ').trim(), waitMinutes: turn.wait_minutes ?? 0 })),
      world: (item.world ?? []).map(event => ({
        beforeTurn: event.before_turn,
        otherVisitor: event.other_visitor,
        offering: event.slot.offering,
        day: event.slot.day,
        time: event.slot.time,
      })),
    }))
}

/** Writes text as a TypeScript string literal in the project's style: single quotes, with the text's own escaped. */
function quote(text: string): string {
  return `'${text.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}'`
}

/** Writes a list of words as a TypeScript array literal. */
function words(list: readonly string[]): string {
  return `[${list.map(quote).join(', ')}]`
}

/** Writes one sample as an object literal, one field to a line. */
function renderSample(sample: Sample): string {
  const turns = sample.turns.map(turn => `      { say: ${quote(turn.say)}, waitMinutes: ${turn.waitMinutes} },`)
  const world = sample.world.map(event => `      { beforeTurn: ${event.beforeTurn}, otherVisitor: ${quote(event.otherVisitor)}, offering: ${quote(event.offering)}, day: ${event.day}, time: ${quote(event.time)} },`)
  return [
    '  {',
    `    id: ${quote(sample.id)},`,
    `    language: ${quote(sample.language)},`,
    `    covers: ${words(sample.covers)},`,
    '    turns: [',
    ...turns,
    '    ],',
    world.length === 0 ? '    world: [],' : '    world: [',
    ...(world.length === 0 ? [] : [...world, '    ],']),
    '  },',
  ].join('\n')
}

/** Writes the samples file: its header, the samples and the type of their IDs. */
function renderSamples(samples: readonly Sample[]): Generated {
  const text = [
    '// GENERATED by scripts/generate-lb02.ts from the cases marked `sample: true` in evals/lb02/golden.yaml.',
    '// Do not edit it by hand: change the golden set and run `pnpm --filter @lb/web samples`.',
    '// `pnpm check` fails when this file is out of date.',
    'import type { ConversationSample } from \'./lb02-types\'',
    '',
    '/** The curated conversations LB-02\'s demo opens on, in the golden set\'s order. */',
    'export const LB02_SAMPLES = [',
    ...samples.map(renderSample),
    '] as const satisfies readonly ConversationSample[]',
    '',
    '/** The ID of one of LB-02\'s samples, such as `book-cupping-en`. */',
    'export type Lb02SampleId = (typeof LB02_SAMPLES)[number][\'id\']',
    '',
  ].join('\n')
  return { file: SAMPLES_FILE, text }
}

/** Copies the brand's app icon, byte for byte: the mark is never redrawn (brand/README.md). */
function renderIcon(): Generated {
  return { file: ICON_FILE, text: readFileSync(BRAND_ICON, 'utf8') }
}

/** Writes the web app manifest of one language. */
function renderManifest(language: 'en' | 'cs'): Generated {
  const pwa = language === 'cs' ? cs.pwa : en.pwa
  const typeset = (text: string): string => (language === 'cs' ? vlna(text) : text)
  const board = BOARD_PATHS[language]
  const manifest = {
    id: `${board}/board`,
    name: typeset(pwa.name),
    short_name: typeset(pwa.shortName),
    description: typeset(pwa.description),
    lang: language,
    dir: 'ltr',
    start_url: `${board}/board`,
    scope: `${board}/`,
    display: 'standalone',
    orientation: 'portrait',
    background_color: BACKGROUND_COLOR,
    theme_color: THEME_COLOR,
    categories: ['food', 'lifestyle'],
    icons: [{ src: '/lb02-icon.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' }],
  }
  return { file: here(`../public/lb02.${language}.webmanifest`), text: `${JSON.stringify(manifest, null, 2)}\n` }
}

/** Writes text so a browser reads it as text: the five characters that can start markup or end an attribute are escaped. */
function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\'', '&#39;')
}

/**
 * Writes the page of one language that the service worker shows when the board's own page is not kept on
 * the device and there is no connection. It is a file of its own, outside the app, so it cannot use the
 * design tokens or the app's fonts: it takes the colours of the visitor's system (light or dark) and its
 * own font, and holds two sentences and a link back to the board.
 */
function renderOfflinePage(language: 'en' | 'cs'): Generated {
  const messages = language === 'cs' ? cs : en
  const typeset = (text: string): string => escapeHtml(language === 'cs' ? vlna(text) : text)
  const text = [
    '<!doctype html>',
    `<html lang="${language}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${typeset(messages.app.offlineTitle)}</title>`,
    '<style>',
    ':root { color-scheme: light dark; }',
    'body { margin: 0; padding: 24px 16px; font: 16px/1.5 system-ui, sans-serif; color: CanvasText; background: Canvas; }',
    'main { max-width: 34rem; margin: 12vh auto 0; }',
    'h1 { margin: 0 0 12px; font-size: 1.5rem; }',
    'a { color: LinkText; }',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    `<h1>${typeset(messages.app.offlineTitle)}</h1>`,
    `<p>${typeset(messages.app.offlineText)}</p>`,
    `<p><a href="${BOARD_PATHS[language]}/board">${typeset(messages.ended.retry)}</a></p>`,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
  return { file: here(`../public/lb02-offline.${language}.html`), text }
}

/** Makes everything the script is responsible for. */
function renderAll(): Generated[] {
  return [renderSamples(readSamples()), renderIcon(), renderManifest('en'), renderManifest('cs'), renderOfflinePage('en'), renderOfflinePage('cs')]
}

/** Reads a file as it is now, or an empty text when it does not exist. */
function current(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

const files = renderAll()

if (process.argv.includes('--check')) {
  const stale = files.filter(item => current(item.file) !== item.text)
  for (const item of stale) console.error(`${item.file.replace(here('../'), 'apps/web/')} is out of date. Run \`pnpm --filter @lb/web samples\` and commit the result.`)
  if (stale.length > 0) process.exit(1)
  console.log('LB-02\'s samples, icon, manifests and offline pages are up to date.')
}
else {
  for (const item of files) {
    mkdirSync(dirname(item.file), { recursive: true })
    writeFileSync(item.file, item.text)
    console.log(`Wrote ${item.file}.`)
  }
}
