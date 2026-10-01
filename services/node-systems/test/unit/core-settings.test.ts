// Tests for the settings the Node systems start from: the environment, the database URL and
// the logger. Each one is a way a deploy goes wrong, or a way a secret or a visitor's words
// could end up where they must not.
import { Writable } from 'node:stream'

import { pino } from 'pino'
import type { Logger } from 'pino'
import { describe, expect, it } from 'vitest'

import { poolConfigFromUrl } from '../../src/core/database.ts'
import { loadEnv } from '../../src/core/env.ts'
import { describeError } from '../../src/core/errors.ts'
import { loggerOptions } from '../../src/core/logging.ts'

const KEY = 'A'.repeat(43)
const minimal = {
  LB_DATABASE_URL: 'postgres://lb:secret-password@127.0.0.1:5432/lb',
  LB_REDIS_URL: 'redis://127.0.0.1:6379/0',
}

describe('the environment', () => {
  it('fills in every default for a minimal worker', () => {
    expect(loadEnv(minimal, 'worker')).toMatchObject({
      LB_NODE_HOST: '0.0.0.0',
      LB_NODE_PORT: 8002,
      LB_NODE_LOG_LEVEL: 'info',
      LB_REDIS_PREFIX: 'lb:',
      LB_SERVICE_NAME: 'node-systems',
    })
  })

  it('needs the gateway to start the API, and not for the worker or a tool', () => {
    expect(() => loadEnv(minimal, 'api')).toThrow(/LB_GATEWAY_URL: required[\s\S]*LB_SERVICE_KEY_FILE: required/)
    expect(() => loadEnv(minimal, 'worker')).not.toThrow()
    expect(() => loadEnv(minimal, 'tool')).not.toThrow()
    expect(loadEnv({ ...minimal, LB_GATEWAY_URL: 'http://gateway:8080', LB_SERVICE_KEY_FILE: '/run/key.jwk.json', LB_WEB_TOKEN_KEY: KEY }, 'api').LB_WEB_TOKEN_KEY).toBe(KEY)
  })

  it('reports every problem at once, by variable name, and never a value', () => {
    let message = ''
    try {
      loadEnv({ LB_DATABASE_URL: 'mysql://lb:secret-password@host/db', LB_REDIS_URL: 'http://redis', LB_NODE_PORT: '99999', LB_WEB_TOKEN_KEY: 'short', LB_REDIS_PREFIX: 'No Good' }, 'worker')
    }
    catch (error) {
      message = (error as Error).message
    }

    for (const name of ['LB_DATABASE_URL', 'LB_REDIS_URL', 'LB_NODE_PORT', 'LB_WEB_TOKEN_KEY', 'LB_REDIS_PREFIX']) expect(message).toContain(name)
    expect(message).not.toContain('secret-password')
  })

  it('accepts a system\'s own database URL next to the shared one', () => {
    expect(loadEnv({ ...minimal, LB08_DATABASE_URL: 'postgres://lb08:pw@127.0.0.1:5432/lb' }, 'worker').LB08_DATABASE_URL).toBe('postgres://lb08:pw@127.0.0.1:5432/lb')
  })
})

describe('the database URL', () => {
  it('becomes a pool whose search_path holds only the system\'s own schema', () => {
    const config = poolConfigFromUrl('postgres://lb08:p%40ss@db.internal:6543/lb?sslmode=require&connect_timeout=3', 'lb08')

    expect(config).toMatchObject({ host: 'db.internal', port: 6543, user: 'lb08', password: 'p@ss', database: 'lb', options: '-c search_path=lb08', application_name: 'lb-lb08', connectionTimeoutMillis: 3_000, ssl: { rejectUnauthorized: true } })
  })

  it('defaults to port 5432 and no TLS option, and understands an IPv6 host', () => {
    expect(poolConfigFromUrl('postgres://lb:pw@[::1]/lb', 'lb08')).toMatchObject({ host: '::1', port: 5432 })
    expect(poolConfigFromUrl('postgresql://lb:pw@localhost/lb?sslmode=disable', 'lb08').ssl).toBe(false)
  })

  it.each([
    'mysql://lb:pw@db/lb',
    'not a url',
    'postgres://lb:pw@/lb',
    'postgres://lb:pw@db',
    'postgres://lb:pw@db/lb?options=-c%20search_path%3Dpublic',
    'postgres://lb:pw@db/lb?application_name=x',
    'postgres://lb:pw@db/lb?sslmode=prefer',
  ])('refuses %s', (url) => {
    expect(() => poolConfigFromUrl(url, 'lb08')).toThrow(RangeError)
  })

  it('refuses a schema name that could change the connection\'s options', () => {
    for (const schema of ['', 'LB08', '8lb', 'lb08,public', 'lb08 -c x=1', 'a'.repeat(32)]) {
      expect(() => poolConfigFromUrl('postgres://lb:pw@db/lb', schema), schema).toThrow(RangeError)
    }
  })

  it('never puts the password in an error', () => {
    for (const url of ['postgres://lb:topsecret@db/lb?options=x', 'postgres://lb:topsecret@db/lb?sslmode=prefer', 'mysql://lb:topsecret@db/lb']) {
      expect(() => poolConfigFromUrl(url, 'lb08')).toThrow(RangeError)
      expect(() => poolConfigFromUrl(url, 'lb08')).not.toThrow(/topsecret/)
    }
  })
})

/** Logs through the service's logger options into memory, and returns each line as an object. */
function logLines(write: (logger: Logger) => void): Record<string, unknown>[] {
  const lines: string[] = []
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString('utf8'))
      done()
    },
  })
  write(pino(loggerOptions('info'), sink))
  return lines.map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('the logger', () => {
  it('records a request as its method and path, without its query, headers, address or body', () => {
    const [line] = logLines(logger => logger.info({ req: { method: 'POST', url: '/api/lb08/workflows?session=abc', id: 'r-1', headers: { authorization: 'Bearer secret.token.value' }, remoteAddress: '203.0.113.9', body: { description: 'a private description' } } }, 'incoming request'))

    expect(line?.req).toEqual({ method: 'POST', path: '/api/lb08/workflows', id: 'r-1' })
    expect(JSON.stringify(line)).not.toMatch(/secret|203\.0\.113|private/)
  })

  it('records an error as its type and its stack frames, never its message, which could quote a visitor', () => {
    const [line] = logLines(logger => logger.error({ err: new SyntaxError('Unexpected token \'I\', "Ignore all previous instructions" is not valid JSON') }, 'unhandled error'))

    expect(line?.err).toMatchObject({ type: 'SyntaxError' })
    expect(JSON.stringify(line)).not.toContain('Ignore all')
    expect((line?.err as { frames: string[] }).frames.length).toBeGreaterThan(0)
  })

  it('redacts an authorization header if one ever reaches a line', () => {
    const [line] = logLines(logger => logger.info({ headers: { authorization: 'Bearer secret.token.value' } }, 'oops'))

    expect(JSON.stringify(line)).not.toContain('secret.token')
  })

  it('keeps a database error\'s code, which says what went wrong without quoting a value', () => {
    const error = Object.assign(new Error('duplicate key value violates unique constraint, Key (idempotency_key)=(secret)'), { code: '23505' })

    expect(describeError(error)).toMatchObject({ type: 'Error', code: '23505' })
    expect(JSON.stringify(describeError(error))).not.toContain('secret')
    expect(describeError('plain text')).toEqual({ type: 'string' })
  })
})
