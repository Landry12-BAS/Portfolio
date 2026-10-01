// A check on the text of every request body, before any route sees it.
//
// Postgres can't store a NUL character in text or in JSON, so a visitor who sends one would
// turn a validation problem into a 500. Other control characters and the bidirectional
// overrides do no honest work in these systems' text and can make a log or a Slack message
// read differently from what it says. So a body whose strings (or keys) hold any of them,
// or hold half of an emoji, is refused at the door with a 422. Tabs and line breaks stay,
// because a description may run over several lines.
import type { FastifyInstance } from 'fastify'

import { AppError } from './errors.ts'

// Control characters: C0, DEL and C1.
const CONTROL = /\p{Cc}/u
// The control characters a text may keep.
const WHITESPACE = /[\t\n\r]/g
// A body is a few kilobytes of data; refusing a deeper nesting than any of them uses costs nothing.
const MAX_DEPTH = 32
// So does refusing a body with more strings than any honest request has.
const MAX_STRINGS = 5_000

/** Tells whether a code point is one of the bidirectional embeddings, overrides and isolates (U+202A to U+202E, U+2066 to U+2069). */
function isBidiControl(codePoint: number): boolean {
  return (codePoint >= 0x202A && codePoint <= 0x202E) || (codePoint >= 0x2066 && codePoint <= 0x2069)
}

/** Tells whether a piece of text holds one of the bidirectional controls. */
function hasBidiControl(text: string): boolean {
  for (const character of text) {
    if (isBidiControl(character.codePointAt(0) ?? 0)) return true
  }
  return false
}

/** Tells whether a piece of text may be stored and shown: well-formed, with no control characters but tabs and line breaks, and no bidirectional controls. */
export function isSafeText(text: string): boolean {
  return text.isWellFormed() && !CONTROL.test(text.replaceAll(WHITESPACE, '')) && !hasBidiControl(text)
}

/** One value still to be checked, and how deep in the body it sits. */
interface Pending {
  value: unknown
  depth: number
}

/**
 * Tells whether every string and every key in a parsed body is safe text. It walks the
 * body with a stack of its own rather than by recursion, and gives up on a body that is
 * deeper or wider than any honest request, so hostile input costs a bounded amount.
 */
export function bodyTextIsSafe(body: unknown): boolean {
  const stack: Pending[] = [{ value: body, depth: 0 }]
  let strings = 0
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { value, depth } = next
    if (typeof value === 'string') {
      strings += 1
      if (strings > MAX_STRINGS || !isSafeText(value)) return false
    }
    else if (typeof value === 'object' && value !== null) {
      if (depth >= MAX_DEPTH) return false
      for (const [key, inner] of Object.entries(value)) {
        strings += 1
        if (strings > MAX_STRINGS || !isSafeText(key)) return false
        stack.push({ value: inner, depth: depth + 1 })
      }
    }
  }
  return true
}

/** Refuses, with a 422, any request whose body holds text that isn't safe to store (see this file's header). */
export function registerTextGuard(app: FastifyInstance): void {
  app.addHook('preValidation', async (request) => {
    if (request.body !== undefined && request.body !== null && !bodyTextIsSafe(request.body)) {
      throw new AppError(422, 'invalid_request', 'Text can\'t hold control characters or unpaired surrogates.')
    }
  })
}
