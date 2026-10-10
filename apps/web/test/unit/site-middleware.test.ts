// Tests for the two decisions the site makes before it answers anything: whether a path is the API's
// (which gets the site's services), and where a request for another host is sent on to. The middleware that
// applies them is tested over HTTP in test/integration/hosts.test.ts.
import { describe, expect, it } from 'vitest'

import { canonicalLocation, isApiPath } from '../../server/lib/site-middleware.ts'

const SITE = new URL('https://example.com')

describe('isApiPath', () => {
  it.each(['/api', '/api/', '/api/session', '/api?x=1', '/api/?x=1', '/api/lb01/tickets?after=1', '/api/runs/run-0123456789/spans'])('says %s is the API\'s', (path) => {
    expect(isApiPath(path)).toBe(true)
  })

  it.each(['/', '/apis', '/api2', '/apiary', '/API', '/api.json', '/systems/api', '//api/session', '/ api', '/cs/api', ''])('says %s is not', (path) => {
    expect(isApiPath(path)).toBe(false)
  })
})

describe('canonicalLocation', () => {
  it('is nothing when the site has no address of its own, whatever the host', () => {
    expect(canonicalLocation('www.example.com', '/systems', undefined)).toBeUndefined()
  })

  it('is nothing for the site\'s own host, however it is written', () => {
    for (const host of ['example.com', 'EXAMPLE.COM', 'Example.com']) expect(canonicalLocation(host, '/systems', SITE)).toBeUndefined()
  })

  it('is the same path and query on the site\'s own origin for any other host', () => {
    expect(canonicalLocation('www.example.com', '/systems/lb-01?tab=trace', SITE)).toBe('https://example.com/systems/lb-01?tab=trace')
    expect(canonicalLocation('x.vercel.app', '/', SITE)).toBe('https://example.com/')
    expect(canonicalLocation('', '/', SITE)).toBe('https://example.com/')
  })

  it('keeps a port that is not the default part of the host, so another port is another host', () => {
    const local = new URL('http://127.0.0.1:3100')

    expect(canonicalLocation('127.0.0.1:3100', '/', local)).toBeUndefined()
    expect(canonicalLocation('127.0.0.1:3101', '/x', local)).toBe('http://127.0.0.1:3100/x')
    expect(canonicalLocation('127.0.0.1', '/x', local)).toBe('http://127.0.0.1:3100/x')
    expect(canonicalLocation('example.com:8443', '/x', SITE)).toBe('https://example.com/x')
  })

  it('never lets the path choose where it goes: it is always a path on the site\'s own origin', () => {
    for (const path of ['//evil.example/x', '/\\evil.example', 'http://evil.example/', 'evil.example', '', '/..//evil.example']) {
      const location = canonicalLocation('www.example.com', path, SITE) ?? ''

      expect(new URL(location).origin, path).toBe('https://example.com')
      expect(location.startsWith('https://example.com/'), path).toBe(true)
    }
  })

  it('repeats a path as it was written, percent-escapes and all, and never as text that could not be a header', () => {
    expect(canonicalLocation('www.example.com', '/a%20b?q=%0d%0a', SITE)).toBe('https://example.com/a%20b?q=%0d%0a')
    for (const target of ['/\r\nSet-Cookie: x=1', '/a b', '/\u202e', '/caf\u00e9', '/\u0000']) {
      expect(canonicalLocation('www.example.com', target, SITE), JSON.stringify(target)).toBe('https://example.com/')
    }
  })
})
