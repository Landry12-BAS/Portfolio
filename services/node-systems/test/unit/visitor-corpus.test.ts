// Runs the shared corpus of visitor tokens through the Node systems' own authentication: the verifier
// every module is given and the Fastify hook that answers 401. @lb/common's tests run the corpus against
// the check itself, python/lb-common's against the Python twin, and the Django and Flask systems through
// theirs, so every system accepts and refuses exactly the same tokens (docs/SECURITY.md, section 2).
import { createVisitorVerifier } from '@lb/common'
import { loadVisitorTokenCorpus } from '@lb/common/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../src/core/app.ts'
import { fakeModule } from '../support/fake-module.ts'

const corpus = loadVisitorTokenCorpus()
const systems = [...new Set([...corpus.tokens, ...corpus.headers].map(entry => entry.system))].sort()
const WHOAMI = '/api/lb99/whoami'
const apps = new Map<string, FastifyInstance>()

beforeAll(async () => {
  for (const system of systems) {
    apps.set(system, await buildApp({ modules: [fakeModule(createVisitorVerifier(system, corpus.publicKey, () => corpus.now))] }))
  }
})

afterAll(async () => {
  await Promise.all([...apps.values()].map(async app => app.close()))
})

/** Tells whether a header value can arrive over HTTP: tabs and printable Latin-1, no line breaks or controls. */
function reachable(value: string): boolean {
  return [...value].every(character => character === '\t' || (character >= ' ' && character <= '\u00ff' && character !== '\u007f'))
}

/** Tells whether a token can be sent as `Bearer <token>`: it can arrive, and has no space or tab at its ends, which the header would read as its own padding. */
function survivesABearerHeader(token: string): boolean {
  return reachable(`Bearer ${token}`) && !/^[ \t]|[ \t]$/.test(token)
}

/** Calls the guarded route of one system with an Authorization header, or none. */
async function whoami(system: string, authorization: string | null): Promise<{ status: number, session?: string }> {
  const app = apps.get(system)
  if (!app) throw new Error(`The corpus has no app for ${system}.`)
  const response = await app.inject({ method: 'GET', url: WHOAMI, headers: authorization === null ? {} : { authorization } })
  return { status: response.statusCode, session: response.statusCode === 200 ? response.json<{ session: string }>().session : undefined }
}

describe('a token of the corpus, sent as a Bearer header', () => {
  const accepted = corpus.tokens.filter(entry => entry.expect === 'ok' && survivesABearerHeader(entry.token))
  const refused = corpus.tokens.filter(entry => entry.expect === 'refuse' && survivesABearerHeader(entry.token))

  it.each(accepted)('is let in: $name ($rule)', async ({ system, token, sessionKey }) => {
    expect(await whoami(system, `Bearer ${token}`)).toEqual({ status: 200, session: sessionKey })
  })

  it.each(refused)('is answered with 401: $name ($rule)', async ({ system, token }) => {
    expect((await whoami(system, `Bearer ${token}`)).status).toBe(401)
  })
})

describe('an Authorization header of the corpus', () => {
  const accepted = corpus.headers.filter(entry => entry.expect === 'ok' && reachable(entry.authorization ?? ''))
  const refused = corpus.headers.filter(entry => entry.expect === 'refuse' && reachable(entry.authorization ?? ''))

  it.each(accepted)('is let in: $name ($rule)', async ({ system, authorization }) => {
    expect((await whoami(system, authorization)).status).toBe(200)
  })

  it.each(refused)('is answered with 401: $name ($rule)', async ({ system, authorization }) => {
    expect((await whoami(system, authorization)).status).toBe(401)
  })
})
