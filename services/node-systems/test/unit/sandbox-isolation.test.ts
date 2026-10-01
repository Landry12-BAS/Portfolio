// Evidence for the claim at the heart of LB-08's threat model: a visitor cannot make the
// engine run code or reach a network. The files that handle a visitor's workflow and
// payload (the flow rules, the rendering of text, the connectors, the outbox) are read as
// text, and none of them may import a module that can open a connection, start a process
// or run code from a string, or name one of the functions that do. This is a tripwire for the
// future, not a proof: it fails when someone adds such a thing to the sandbox, and the
// threat model in the README says what else holds the line (closed lists in the schema,
// validation before storage, no way to pass a URL or an address).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const engine = fileURLToPath(new URL('../../src/modules/lb08/engine/', import.meta.url))
// What a visitor's data passes through while a workflow runs.
const SANDBOX_FILES = ['flow.ts', 'context.ts', 'settle.ts', 'sandbox.ts', 'outbox.ts', 'state.ts', 'keys.ts', 'events.ts'] as const

// Modules that can reach a network, start a process or run text as code.
const FORBIDDEN_MODULES = [
  'node:http', 'node:https', 'node:http2', 'node:net', 'node:tls', 'node:dgram', 'node:dns', 'node:child_process',
  'node:cluster', 'node:worker_threads', 'node:vm', 'node:repl', 'node:inspector', 'node:module', 'node:fs', 'node:fs/promises',
  'http', 'https', 'net', 'tls', 'dns', 'child_process', 'vm', 'fs', 'undici', 'axios', 'node-fetch', 'got', 'ws', 'bullmq', 'ioredis',
] as const

// Functions and globals that do the same without an import.
const FORBIDDEN_CALLS = [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\beval\s*\(/, /\bnew\s+Function\b/, /\bimport\s*\(/, /\brequire\s*\(/, /\bprocess\.(?:binding|dlopen|kill)\b/, /\bprocess\.env\b/] as const

/** Lists the modules a file imports. */
function importsOf(source: string): string[] {
  return [...source.matchAll(/\bfrom '([^']+)'/g)].map(match => match[1] ?? '')
}

describe('the sandbox', () => {
  it.each(SANDBOX_FILES)('%s imports nothing that can open a connection, start a process or run text as code', (name) => {
    const source = readFileSync(`${engine}${name}`, 'utf8')

    const used = importsOf(source).filter(module => (FORBIDDEN_MODULES as readonly string[]).includes(module))

    expect(used).toEqual([])
  })

  it.each(SANDBOX_FILES)('%s calls nothing that does so without an import, and reads no environment variable', (name) => {
    const source = readFileSync(`${engine}${name}`, 'utf8').split('\n').filter(line => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*') && !line.trimStart().startsWith('/**')).join('\n')

    for (const pattern of FORBIDDEN_CALLS) expect(source, String(pattern)).not.toMatch(pattern)
  })

  it('reaches its data only through the database tables of LB-08\'s own schema', () => {
    const imports = SANDBOX_FILES.flatMap(name => importsOf(readFileSync(`${engine}${name}`, 'utf8')))

    // Everything from outside the engine folder is the schema, the connection types, the contracts or drizzle's query builders.
    const outside = [...new Set(imports.filter(module => !module.startsWith('./')))].sort()
    expect(outside).toEqual(['../db/connection.ts', '../db/schema.ts', '@lb/contracts', 'drizzle-orm', 'node:crypto'])
  })

  it('has connectors that are only a table of closed names: the catalogue lists no URL and no real address', async () => {
    const { CONNECTORS, EMAIL_RECIPIENTS, SLACK_CHANNELS, TASK_BOARDS, WEBHOOK_ENDPOINTS } = await import('@lb/contracts')
    const everyChoice = [...EMAIL_RECIPIENTS, ...SLACK_CHANNELS, ...TASK_BOARDS, ...WEBHOOK_ENDPOINTS, ...Object.keys(CONNECTORS)]

    for (const choice of everyChoice) expect(choice, choice).toMatch(/^#?[a-z][a-z_]*$/)
    expect(JSON.stringify(CONNECTORS)).not.toMatch(/https?:|@|\.com|\.net|\.org/)
  })
})
