// Unit tests for the gateway's request-log serializer: a run's ID, which is the key to its trace, is
// replaced in any URL that has one, nothing else in the log line changes, and the serializer is put
// into whatever logger the gateway is built with.
import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'

import { redactingLogger, redactRunId, serializeRequest } from '../../src/log.ts'

describe('redactRunId', () => {
  it.each([
    ['/v1/runs/run-0123456789ab/spans', '/v1/runs/:runId/spans'],
    ['/v1/runs/run-0123456789ab/spans?after=1790000000123-0&limit=5', '/v1/runs/:runId/spans?after=1790000000123-0&limit=5'],
    ['/v1/runs/run-0123456789ab', '/v1/runs/:runId'],
    ['/v1/runs/run-0123456789ab?limit=5', '/v1/runs/:runId?limit=5'],
    ['/v1/runs/not~a~run~id/spans', '/v1/runs/:runId/spans'],
    ['/v1/runs//spans', '/v1/runs/:runId/spans'],
    ['/v1/runs/a-first-run/spans/runs/a-second-run', '/v1/runs/:runId/spans/runs/:runId'],
  ])('writes %s as %s', (url, expected) => {
    expect(redactRunId(url)).toBe(expected)
  })

  it.each([
    '/v1/chat/completions',
    '/v1/embeddings',
    '/healthz',
    '/readyz',
    '/v1/runs',
    '/',
  ])('leaves %s as it is', (url) => {
    expect(redactRunId(url)).toBe(url)
  })
})

describe('serializeRequest', () => {
  it('writes the fields Fastify\'s own serializer writes, with the run\'s ID left out, and no headers', () => {
    const request = {
      method: 'GET',
      url: '/v1/runs/run-0123456789ab/spans',
      host: 'gateway:8080',
      ip: '10.0.0.7',
      socket: { remotePort: 41234 },
      headers: { 'authorization': 'Bearer secret', 'x-lb-session': 'a-session', 'x-lb-run-id': 'run-0123456789ab' },
    } as unknown as FastifyRequest

    const line = serializeRequest(request)

    expect(line).toEqual({ method: 'GET', url: '/v1/runs/:runId/spans', host: 'gateway:8080', remoteAddress: '10.0.0.7', remotePort: 41234 })
    expect(JSON.stringify(line)).not.toContain('secret')
    expect(JSON.stringify(line)).not.toContain('run-0123456789ab')
  })

  it('copes with a request that has no socket', () => {
    const request = { method: 'GET', url: '/healthz', host: 'gateway', ip: '10.0.0.7' } as unknown as FastifyRequest

    expect(serializeRequest(request).remotePort).toBeUndefined()
  })
})

describe('redactingLogger', () => {
  it('leaves a logger that is off, or never asked for, off', () => {
    expect(redactingLogger(false)).toBe(false)
    expect(redactingLogger(undefined)).toBe(false)
  })

  it('turns a plain "log" into one that holds the serializer', () => {
    const logger = redactingLogger(true)

    expect(logger).toMatchObject({ serializers: { req: serializeRequest } })
  })

  it('keeps what the caller set, and puts its own request serializer in place of the caller\'s', () => {
    const logger = redactingLogger({
      level: 'warn',
      redact: { paths: ['req.headers.authorization'], censor: '[redacted]' },
      serializers: { req: () => ({ url: '/leaks/run-0123456789ab' }), res: () => ({ statusCode: 200 }) },
    })

    expect(logger).toMatchObject({ level: 'warn', redact: { paths: ['req.headers.authorization'] }, serializers: { req: serializeRequest } })
    expect(logger).toHaveProperty('serializers.res')
  })
})
