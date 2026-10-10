// Tests of the site's security.txt (RFC 9116), which docs/SECURITY.md (section 8) says points to the
// disclosure policy. A visitor who finds a hole looks for it at /.well-known/security.txt, so the file
// must exist, name a private way to report, and not lapse: the RFC makes an expired file void.
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// A fortnight, so the owner is told in time to renew the file and not after it has lapsed.
const WARNING_MS = 14 * 86_400_000

/** Reads the `Name: value` lines of a security.txt, in order. Comments and blank lines are left out. */
function fieldsOf(text: string): [string, string][] {
  const fields: [string, string][] = []
  for (const line of text.split('\n')) {
    const match = /^([a-z-]+):\s*(\S.*)$/i.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) fields.push([match[1], match[2].trim()])
  }
  return fields
}

/** Tells whether a text holds nothing but printable ASCII, tabs and line feeds. */
function isPlainAscii(text: string): boolean {
  return [...text].every((character) => {
    const code = character.codePointAt(0) ?? 0
    return code === 9 || code === 10 || (code >= 32 && code <= 126)
  })
}

/** Returns every value a security.txt gives for one field name. */
function valuesOf(fields: readonly [string, string][], name: string): string[] {
  return fields.filter(([field]) => field === name).map(([, value]) => value)
}

describe('security.txt', () => {
  const text = readFileSync(new URL('../../public/.well-known/security.txt', import.meta.url), 'utf8')
  const fields = fieldsOf(text)

  it('names a private way to report a problem, and the policy that says how reports are handled', () => {
    const contacts = valuesOf(fields, 'Contact')
    const policies = valuesOf(fields, 'Policy')

    expect(contacts.length).toBeGreaterThan(0)
    for (const contact of contacts) expect(contact).toMatch(/^(?:https:\/\/|mailto:)/)
    expect(policies).toHaveLength(1)
    expect(policies[0]).toMatch(/^https:\/\/github\.com\/[\w-]+\/[\w-]+\/blob\/main\/SECURITY\.md$/)
  })

  it('says when it lapses, once, as a date more than a fortnight away: renew it before then', () => {
    const expires = valuesOf(fields, 'Expires')

    expect(expires).toHaveLength(1)
    const lapses = Date.parse(expires[0] ?? '')
    expect(Number.isNaN(lapses), 'Expires must be a date and time such as 2027-09-30T00:00:00.000Z').toBe(false)
    expect(lapses - Date.now(), 'security.txt lapses within a fortnight: renew its Expires date').toBeGreaterThan(WARNING_MS)
  })

  it('is plain ASCII text, as the RFC asks of a file that tools read by machine', () => {
    expect(isPlainAscii(text)).toBe(true)
  })
})
