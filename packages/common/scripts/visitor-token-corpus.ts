// Makes the shared corpus of visitor tokens (`test/fixtures/visitor-tokens.json`): signed tokens, each
// with the verdict every verifier must give it. The TypeScript check (src/visitors.ts) and the Python
// one (python/lb-common/src/lb_common/visitors.py), which the Django, Flask and Node systems all
// use, run the same file in their own tests, so they accept and refuse exactly the same tokens
// (docs/SECURITY.md, section 2). Each case names the rule it tests; the rules are written out in the file.
//
//   node scripts/visitor-token-corpus.ts            write the corpus
//   node scripts/visitor-token-corpus.ts --check    fail when the file is not what this script makes
//
// Nothing here is secret. The signing key comes from a seed made from a public phrase, so the corpus
// is the same every time it is made (Ed25519 signatures are deterministic) and `--check` can tell
// when a rule changed and the file was not made again. The key opens nothing: no service is ever
// given its public half except by a test.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

import type { CorpusHeaderCase, CorpusKeyCase, CorpusTokenCase } from '../src/testing.ts'

// Where the corpus lives, next to the tests that read it.
const CORPUS_FILE = new URL('../test/fixtures/visitor-tokens.json', import.meta.url)
// The moment every case is judged at, in Unix seconds, so a token's age is part of the case.
const NOW = 1_790_000_000
// A session hash as the site makes it: 43 characters of base64url.
const SESSION = 'Zk3mQ9vP2xT7aB1cD4eF6gH8iJ0kL5nO-_sUvWxYzAB'
// The systems the site calls on a visitor's behalf.
const SYSTEMS = ['lb-01', 'lb-02', 'lb-05', 'lb-08'] as const
// The most characters a token may have, and the one rule that needs a token of exactly that size.
const MAX_TOKEN_LENGTH = 2_048

/** The rules the cases test, in words, so the file explains itself. */
const RULES: Readonly<Record<string, string>> = {
  T1: 'A token is at most 2048 characters.',
  T2: 'A token is three segments of letters, digits, "-" and "_", none empty, joined by dots: no padding, no spaces, nothing else.',
  T3: 'Each segment is canonical base64url: it decodes, and encodes back to the same text.',
  T4: 'The header is a UTF-8 JSON object with no byte order mark, whose members are strings, numbers, booleans or null; "alg" is exactly "EdDSA"; there is no "crit" member.',
  T5: 'The signature is 64 bytes and verifies, as Ed25519 (RFC 8032, so with S reduced) with the site\'s key, over the first two segments as written.',
  T6: 'The claims are a UTF-8 JSON object with no byte order mark, whose members are strings, numbers, booleans or null, except "aud", which may be a list of strings; "iss", "aud", "sub", "iat" and "exp" are all there.',
  T7: '"iss" is exactly "lb-web".',
  T8: '"aud" is the system\'s name, as a string or in a list that holds nothing but strings.',
  T9: '"iat", "exp" and "nbf" (when there) are JSON numbers with a whole value no bigger than 2^53 - 1: 1.0 and 1e9 are whole; 1.5, strings, booleans, null and lists are not.',
  T10: '"exp" is 1 to 300 seconds after "iat".',
  T11: 'With 30 seconds of leeway, "exp" is later than now - 30, and "iat" and "nbf" are no later than now + 30.',
  T12: '"sub" is 16 to 128 letters, digits, "-" and "_".',
  T13: 'Any other member is ignored, as long as its value is a string, number, boolean or null.',
  H1: 'An Authorization header is stripped of leading and trailing spaces and tabs, and of nothing else.',
  H2: 'What is left is "Bearer" in any case, one or more spaces, and a token (T1 to T13), with nothing after it.',
  K1: 'The site\'s key is the unpadded, canonical base64url of exactly 32 bytes.',
}

/** Makes the corpus's one signing key from a seed that is public on purpose. */
function corpusKey(): KeyObject {
  const seed = createHash('sha256').update('lb visitor-token corpus: a signing key that is public on purpose').digest()
  // The fixed start of an Ed25519 key in PKCS#8 form, then the 32 bytes of the seed.
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex')
  return createPrivateKey({ key: Buffer.concat([pkcs8Prefix, seed]), format: 'der', type: 'pkcs8' })
}

const privateKey = corpusKey()
const publicKeyText = createPublicKey(privateKey).export({ format: 'jwk' }).x ?? ''

/** Writes bytes as base64url, without padding. */
function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/** Turns a value into the text of one segment: an object is written as JSON, text and bytes are taken as they are. */
function segment(value: unknown): string {
  if (value instanceof Uint8Array) return b64u(value)
  if (typeof value === 'string') return b64u(Buffer.from(value, 'utf8'))
  return b64u(Buffer.from(JSON.stringify(value), 'utf8'))
}

/** Signs the first two segments exactly as written, with the corpus key or another. */
function signature(headerPart: string, claimsPart: string, key: KeyObject = privateKey): Buffer {
  return sign(null, Buffer.from(`${headerPart}.${claimsPart}`), key)
}

/** Builds a token from a header and claims, each an object, raw JSON text or raw bytes, signed over what is written. */
function token(headerValue: unknown, claimsValue: unknown, key: KeyObject = privateKey): string {
  const headerPart = segment(headerValue)
  const claimsPart = segment(claimsValue)
  return `${headerPart}.${claimsPart}.${b64u(signature(headerPart, claimsPart, key))}`
}

/** The header the site writes. */
const HEADER = { alg: 'EdDSA', typ: 'JWT' }

/** The claims the site writes for `system`, issued at `iat`, with any change. */
function claims(changes: Record<string, unknown> = {}, system = 'lb-01', iat = NOW): Record<string, unknown> {
  return { iss: 'lb-web', aud: system, sub: SESSION, iat, exp: iat + 300, ...changes }
}

/** The claims with one member taken out. */
function without(name: string, system = 'lb-01'): Record<string, unknown> {
  return Object.fromEntries(Object.entries(claims({}, system)).filter(([member]) => member !== name))
}

/** Writes claims as JSON text, with each member's value given as the text it should have, so a number can be written as 1.0. */
function jsonText(members: Record<string, string>): string {
  return `{${Object.entries(members).map(([name, value]) => `${JSON.stringify(name)}:${value}`).join(',')}}`
}

/** The members of the site's claims as JSON text, for a case that bends how one is written. */
function claimsText(changes: Record<string, string> = {}, system = 'lb-01'): string {
  return jsonText({ iss: '"lb-web"', aud: JSON.stringify(system), sub: JSON.stringify(SESSION), iat: String(NOW), exp: String(NOW + 300), ...changes })
}

/** Gives a case that must be accepted. */
function ok(name: string, rule: string, tokenText: string, system = 'lb-01', sessionKey = SESSION): CorpusTokenCase {
  return { name, rule, system, token: tokenText, expect: 'ok', sessionKey }
}

/** Gives a case that must be refused. */
function refuse(name: string, rule: string, tokenText: string, system = 'lb-01'): CorpusTokenCase {
  return { name, rule, system, token: tokenText, expect: 'refuse' }
}

/** Builds a token of exactly `length` characters by padding the header with a member that nothing reads. */
function tokenOfLength(length: number): string {
  for (let claimsPad = 0; claimsPad < 8; claimsPad += 1) {
    const claimsValue = claims({ note: 'c'.repeat(claimsPad) })
    for (let headerPad = 0; headerPad < length; headerPad += 1) {
      const candidate = token({ ...HEADER, pad: 'h'.repeat(headerPad) }, claimsValue)
      if (candidate.length === length) return candidate
      if (candidate.length > length) break
    }
  }
  throw new Error(`No token of ${length} characters could be made.`)
}

/** Changes one character of a segment to another that decodes to the same bytes, so the text is not canonical. */
function nonCanonical(part: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const remainder = part.length % 4
  // A segment that is a whole number of four-character groups has no spare bits to set.
  if (remainder !== 2 && remainder !== 3) throw new Error('This segment has no spare bits, so a case made with it would test nothing.')
  // The last character of an unpadded segment holds 2 or 4 bits of data and 4 or 2 bits that must be zero.
  const spareBits = remainder === 2 ? 15 : 3
  const last = alphabet.indexOf(part.slice(-1))
  if ((last & spareBits) !== 0) throw new Error('The last character is not canonical to begin with.')
  return `${part.slice(0, -1)}${alphabet[last + 1]}`
}

/** Splits a token into its three segments. */
function parts(tokenText: string): [string, string, string] {
  const [header = '', claimsPart = '', signaturePart = ''] = tokenText.split('.')
  return [header, claimsPart, signaturePart]
}

/** Writes a segment with the `=` padding standard base64 adds. A segment that needs none would make a case test nothing, so that is a mistake here. */
function padded(part: string): string {
  const fill = (4 - (part.length % 4)) % 4
  if (fill === 0) throw new Error('This segment needs no padding, so a case made with it would test nothing.')
  return `${part}${'='.repeat(fill)}`
}

/** Makes a token out of two segments as they are written, signed over exactly that text. */
function signedAsWritten(headerPart: string, claimsPart: string): string {
  return `${headerPart}.${claimsPart}.${b64u(signature(headerPart, claimsPart))}`
}

/** The claims written as a segment whose length is a multiple of four, so one more character makes a length no base64 text can have. */
function claimsSegmentOfWholeGroups(): string {
  for (let filler = 0; filler < 4; filler += 1) {
    const candidate = segment(claims({ note: 'n'.repeat(filler) }))
    if (candidate.length % 4 === 0) return candidate
  }
  throw new Error('No claims segment of whole groups could be made.')
}

/** The cases for what a token looks like as text: its size, its segments and their encoding (T1 to T3). */
function formCases(good: string): CorpusTokenCase[] {
  const [header, claimsPart, signaturePart] = parts(good)
  const sized = (length: number): string => tokenOfLength(length)
  return [
    ok('a token of exactly 2048 characters', 'T1', sized(MAX_TOKEN_LENGTH)),
    refuse('a token of 2049 characters, signed by the site', 'T1', sized(MAX_TOKEN_LENGTH + 1)),
    refuse('a token of 5000 characters', 'T1', 'x'.repeat(5_000)),
    refuse('an empty token', 'T2', ''),
    refuse('one segment', 'T2', 'abc'),
    refuse('two segments', 'T2', `${header}.${claimsPart}`),
    refuse('four segments', 'T2', `${good}.extra`),
    refuse('an empty header segment', 'T2', `.${claimsPart}.${signaturePart}`),
    refuse('an empty claims segment', 'T2', `${header}..${signaturePart}`),
    refuse('an empty signature segment', 'T2', `${header}.${claimsPart}.`),
    refuse('a space inside a segment', 'T2', `${header} .${claimsPart}.${signaturePart}`),
    refuse('a space before the token', 'T2', ` ${good}`),
    refuse('a newline after the token', 'T2', `${good}\n`),
    refuse('a letter outside the alphabet in a segment', 'T2', `${header}.${claimsPart}.${signaturePart.slice(0, 10)}\u00e9${signaturePart.slice(11)}`),
    refuse('a plus sign, from the standard base64 alphabet', 'T2', `${header}.${claimsPart}.${signaturePart.slice(0, 10)}+${signaturePart.slice(11)}`),
    refuse('a slash, from the standard base64 alphabet', 'T2', `${header}.${claimsPart}.${signaturePart.slice(0, 10)}/${signaturePart.slice(11)}`),
    refuse('a padded signature', 'T2', `${header}.${claimsPart}.${padded(signaturePart)}`),
    refuse('a padded header, signed as written', 'T2', signedAsWritten(padded(segment({ alg: 'EdDSA', typ: 'JWT', k: 'a' })), claimsPart)),
    refuse('a padded claims segment, signed as written', 'T2', signedAsWritten(header, padded(segment(claims({ note: 'p' }))))),
    refuse('a signature whose spare bits are not zero', 'T3', `${header}.${claimsPart}.${nonCanonical(signaturePart)}`),
    refuse('a header whose spare bits are not zero, signed as written', 'T3', signedAsWritten(nonCanonical(segment({ alg: 'EdDSA', typ: 'JWT', k: 'a' })), claimsPart)),
    refuse('a claims segment whose spare bits are not zero, signed as written', 'T3', signedAsWritten(header, nonCanonical(segment(claims({ note: 'q' }))))),
    refuse('a claims segment that is not a whole number of bytes, signed as written', 'T3', signedAsWritten(header, `${claimsSegmentOfWholeGroups()}A`)),
  ]
}

/** The cases for the header: its algorithm, its extensions and how it is written (T4). */
function headerCases(): CorpusTokenCase[] {
  const body = claims()
  return [
    ok('a header with members nothing reads', 'T4', token({ alg: 'EdDSA', typ: 'JWT', kid: 'site-1', extra: true, none: null, count: 3 }, body)),
    ok('a header with no "typ"', 'T4', token({ alg: 'EdDSA' }, body)),
    ok('a header that repeats "alg", where the last one counts', 'T4', token('{"alg":"none","alg":"EdDSA"}', body)),
    refuse('the algorithm "none"', 'T4', `${segment({ alg: 'none', typ: 'JWT' })}.${segment(body)}.`),
    refuse('the algorithm "none", with a signature', 'T4', token({ alg: 'none', typ: 'JWT' }, body)),
    refuse('the algorithm HS256', 'T4', token({ alg: 'HS256', typ: 'JWT' }, body)),
    refuse('the algorithm RS256', 'T4', token({ alg: 'RS256', typ: 'JWT' }, body)),
    refuse('the algorithm "eddsa" in lower case', 'T4', token({ alg: 'eddsa', typ: 'JWT' }, body)),
    refuse('the algorithm "EdDSA " with a space', 'T4', token({ alg: 'EdDSA ', typ: 'JWT' }, body)),
    refuse('the algorithm as a list', 'T4', token({ alg: ['EdDSA'], typ: 'JWT' }, body)),
    refuse('no algorithm', 'T4', token({ typ: 'JWT' }, body)),
    refuse('a "crit" member naming an extension', 'T4', token({ alg: 'EdDSA', crit: ['exp'], exp: 1 }, body)),
    refuse('an empty "crit" member', 'T4', token({ alg: 'EdDSA', crit: [] }, body)),
    refuse('a header that is a list', 'T4', token([], body)),
    refuse('a header that is a string', 'T4', token('"EdDSA"', body)),
    refuse('a header that is a number', 'T4', token('1', body)),
    refuse('a header that is not JSON', 'T4', token('not json', body)),
    refuse('a header with a trailing comma', 'T4', token('{"alg":"EdDSA",}', body)),
    refuse('a header with a byte order mark', 'T4', token(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(HEADER))]), body)),
    refuse('a header that is not UTF-8', 'T4', token(Buffer.concat([Buffer.from('{"alg":"EdDSA","k":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]), body)),
    refuse('a header with NaN in it', 'T4', token('{"alg":"EdDSA","k":NaN}', body)),
    refuse('a header with an embedded key', 'T4', token({ alg: 'EdDSA', jwk: { kty: 'OKP', crv: 'Ed25519', x: publicKeyText } }, body)),
    refuse('a header with a list in it', 'T4', token({ alg: 'EdDSA', k: [1] }, body)),
    refuse('a header nested five hundred deep', 'T4', token(`{"alg":"EdDSA","k":${'['.repeat(500)}${']'.repeat(500)}}`, body)),
  ]
}

/** The same signature with its second half, S, written as S + L, where L is the order of the curve's group: the same equation holds, but RFC 8032 refuses a signature that is not reduced. */
function withUnreducedS(raw: Buffer): Buffer {
  const groupOrder = (1n << 252n) + 27742317777372353535851937790883648493n
  const reduced = BigInt(`0x${Buffer.from(raw.subarray(32)).reverse().toString('hex')}`)
  const unreduced = Buffer.from((reduced + groupOrder).toString(16).padStart(64, '0'), 'hex').reverse()
  return Buffer.concat([raw.subarray(0, 32), unreduced])
}

/** The cases for the signature (T5). */
function signatureCases(good: string): CorpusTokenCase[] {
  const [header, claimsPart, signaturePart] = parts(good)
  const stranger = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), createHash('sha256').update('another key').digest()]), format: 'der', type: 'pkcs8' })
  const raw = Buffer.from(signaturePart, 'base64url')
  return [
    refuse('signed by another key', 'T5', token(HEADER, claims(), stranger)),
    refuse('claims changed after signing', 'T5', `${header}.${segment(claims({ sub: 'someone-else-0123456789' }))}.${signaturePart}`),
    refuse('a header changed after signing', 'T5', `${segment({ alg: 'EdDSA', typ: 'JWT', kid: 'x' })}.${claimsPart}.${signaturePart}`),
    refuse('a signature of 63 bytes', 'T5', `${header}.${claimsPart}.${b64u(raw.subarray(0, 63))}`),
    refuse('a signature of 65 bytes', 'T5', `${header}.${claimsPart}.${b64u(Buffer.concat([raw, Buffer.from([0])]))}`),
    refuse('a signature of 64 zero bytes', 'T5', `${header}.${claimsPart}.${b64u(Buffer.alloc(64))}`),
    refuse('a signature with its last byte changed', 'T5', `${header}.${claimsPart}.${b64u(Buffer.concat([raw.subarray(0, 63), Buffer.from([raw[63] === 0 ? 1 : 0])]))}`),
    refuse('a signature whose S is not reduced (S + L)', 'T5', `${header}.${claimsPart}.${b64u(withUnreducedS(raw))}`),
  ]
}

/** The cases for how the claims are written, and the claims that must be there (T6, T7). */
function claimsFormCases(): CorpusTokenCase[] {
  const cases: CorpusTokenCase[] = [
    ok('claims with members nothing reads', 'T13', token(HEADER, claims({ jti: 'one-use', scope: 'demo', retry: false, none: null, level: 3 }))),
    ok('claims written with spaces and lines', 'T6', token(HEADER, `{\n  "iss": "lb-web",\n  "aud": "lb-01",\n  "sub": "${SESSION}",\n  "iat": ${NOW},\n  "exp": ${NOW + 300}\n}`)),
    ok('claims that repeat "sub", where the last one counts', 'T6', token(HEADER, `{"sub":"short","iss":"lb-web","aud":"lb-01","sub":"${SESSION}","iat":${NOW},"exp":${NOW + 300}}`)),
    ok('member names written with escapes', 'T6', token(HEADER, `{"\\u0069ss":"lb-web","aud":"lb-01","sub":"${SESSION}","iat":${NOW},"exp":${NOW + 300}}`)),
    refuse('claims that are a list', 'T6', token(HEADER, [])),
    refuse('claims that are null', 'T6', token(HEADER, 'null')),
    refuse('claims that are a number', 'T6', token(HEADER, '1')),
    refuse('claims that are not JSON', 'T6', token(HEADER, 'not json')),
    refuse('claims with a trailing comma', 'T6', token(HEADER, `${claimsText().slice(0, -1)},}`)),
    refuse('claims cut short', 'T6', token(HEADER, claimsText().slice(0, 40))),
    refuse('claims with single quotes', 'T6', token(HEADER, claimsText().replaceAll('"', '\''))),
    refuse('claims with a byte order mark', 'T6', token(HEADER, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(claimsText())]))),
    refuse('claims that are not UTF-8', 'T6', token(HEADER, Buffer.concat([Buffer.from(claimsText().slice(0, -1)), Buffer.from(',"k":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]))),
    refuse('claims with NaN in an unread member', 'T6', token(HEADER, `${claimsText().slice(0, -1)},"k":NaN}`)),
    refuse('claims with Infinity in an unread member', 'T6', token(HEADER, `${claimsText().slice(0, -1)},"k":Infinity}`)),
    refuse('an unread member that is an object', 'T6', token(HEADER, claims({ extra: { a: 1 } }))),
    refuse('an unread member that is a list', 'T6', token(HEADER, claims({ extra: [1, 2] }))),
    refuse('an unread member nested five hundred deep', 'T6', token(HEADER, `${claimsText().slice(0, -1)},"k":${'['.repeat(500)}${']'.repeat(500)}}`)),
    refuse('empty claims', 'T6', token(HEADER, {})),
  ]
  for (const name of ['iss', 'aud', 'sub', 'iat', 'exp']) {
    cases.push(refuse(`no "${name}"`, 'T6', token(HEADER, without(name))))
    cases.push(refuse(`"${name}" that is null`, 'T6', token(HEADER, claims({ [name]: null }))))
  }
  cases.push(
    refuse('an issuer that is someone else', 'T7', token(HEADER, claims({ iss: 'someone-else' }))),
    refuse('an issuer in capitals', 'T7', token(HEADER, claims({ iss: 'LB-WEB' }))),
    refuse('an issuer with a space after it', 'T7', token(HEADER, claims({ iss: 'lb-web ' }))),
    refuse('an issuer that is a list', 'T7', token(HEADER, claims({ iss: ['lb-web'] }))),
  )
  return cases
}

/** The cases for who the token is for (T8). */
function audienceCases(): CorpusTokenCase[] {
  return [
    ok('an audience that is a list holding the system', 'T8', token(HEADER, claims({ aud: ['lb-02', 'lb-01'] }))),
    ok('an audience that is a list of the system alone', 'T8', token(HEADER, claims({ aud: ['lb-01'] }))),
    refuse('a token for another system', 'T8', token(HEADER, claims({ aud: 'lb-02' }))),
    refuse('an audience that is a list without the system', 'T8', token(HEADER, claims({ aud: ['lb-02', 'lb-05'] }))),
    refuse('an audience that is a list of the system and a number', 'T8', token(HEADER, claims({ aud: ['lb-01', 1] }))),
    refuse('an audience that is a list of the system and null', 'T8', token(HEADER, claims({ aud: ['lb-01', null] }))),
    refuse('an audience that is a list of the system and a list', 'T8', token(HEADER, claims({ aud: ['lb-01', ['lb-01']] }))),
    refuse('an audience that is an empty list', 'T8', token(HEADER, claims({ aud: [] }))),
    refuse('an audience that is a number', 'T8', token(HEADER, claims({ aud: 1 }))),
    refuse('an audience that is true', 'T8', token(HEADER, claims({ aud: true }))),
    refuse('an audience that is an object', 'T8', token(HEADER, claims({ aud: { 'lb-01': true } }))),
    refuse('an audience with a space after the system', 'T8', token(HEADER, claims({ aud: 'lb-01 ' }))),
    refuse('an audience in capitals', 'T8', token(HEADER, claims({ aud: 'LB-01' }))),
  ]
}

/** The cases for how a time is written (T9). */
function timeFormCases(): CorpusTokenCase[] {
  const times = (changes: Record<string, string>): string => token(HEADER, claimsText(changes))
  return [
    ok('times written with a zero fraction', 'T9', times({ iat: `${NOW}.0`, exp: `${NOW + 300}.0` })),
    ok('times written with an exponent', 'T9', times({ iat: '1.79e9', exp: '1.7900003e9' })),
    ok('a time written as -0 where the other is later', 'T9', times({ nbf: '-0' })),
    ok('a "nbf" written with a zero fraction', 'T9', times({ nbf: `${NOW}.0` })),
    refuse('an "iat" with a fraction', 'T9', times({ iat: `${NOW}.5`, exp: `${NOW + 300}.5` })),
    refuse('an "exp" with a fraction', 'T9', times({ exp: `${NOW + 100}.5` })),
    refuse('an "exp" written as a fraction by exponent', 'T9', times({ exp: '1.79000010005e9' })),
    refuse('an "iat" that is text', 'T9', times({ iat: `"${NOW}"` })),
    refuse('an "exp" that is text', 'T9', times({ exp: `"${NOW + 300}"` })),
    refuse('an "iat" that is true', 'T9', times({ iat: 'true' })),
    refuse('an "exp" that is true', 'T9', times({ exp: 'true' })),
    refuse('an "iat" that is a list', 'T9', times({ iat: `[${NOW}]` })),
    refuse('an "exp" that is a list', 'T9', times({ exp: `[${NOW + 300}]` })),
    refuse('an "iat" that is NaN', 'T9', times({ iat: 'NaN' })),
    refuse('an "exp" that is Infinity', 'T9', times({ exp: 'Infinity' })),
    refuse('an "exp" bigger than any whole number a double holds', 'T9', times({ exp: '1e30' })),
    refuse('an "exp" of 2^53', 'T9', times({ iat: '9007199254740000', exp: '9007199254740992' })),
    refuse('a negative "iat"', 'T9', times({ iat: '-1790000000', exp: '-1789999700' })),
    refuse('a "nbf" with a fraction', 'T9', times({ nbf: `${NOW - 10}.5` })),
    refuse('a "nbf" that is text', 'T9', times({ nbf: `"${NOW - 10}"` })),
    refuse('a "nbf" that is true', 'T9', times({ nbf: 'true' })),
    refuse('a "nbf" that is null', 'T9', times({ nbf: 'null' })),
    refuse('a "nbf" that is a list', 'T9', times({ nbf: `[${NOW - 10}]` })),
  ]
}

/** The cases for how long a token lives and when (T10, T11). */
function timeCases(): CorpusTokenCase[] {
  return [
    ok('a token that lives one second', 'T10', token(HEADER, claims({ exp: NOW + 1 }))),
    ok('a token that lives 300 seconds', 'T10', token(HEADER, claims())),
    ok('a token a hundred seconds old', 'T11', token(HEADER, claims({}, 'lb-01', NOW - 100))),
    ok('a token that expired 29 seconds ago', 'T11', token(HEADER, claims({}, 'lb-01', NOW - 329))),
    ok('a token issued 30 seconds ahead', 'T11', token(HEADER, claims({}, 'lb-01', NOW + 30))),
    ok('a "nbf" that has passed', 'T11', token(HEADER, claims({ nbf: NOW - 10 }))),
    ok('a "nbf" 30 seconds ahead', 'T11', token(HEADER, claims({ nbf: NOW + 30 }))),
    refuse('a token that lives 301 seconds', 'T10', token(HEADER, claims({ exp: NOW + 301 }))),
    refuse('a token that lives a day', 'T10', token(HEADER, claims({ exp: NOW + 86_400 }))),
    refuse('a token that expires when it was issued', 'T10', token(HEADER, claims({ exp: NOW }))),
    refuse('a token that expires before it was issued', 'T10', token(HEADER, claims({ exp: NOW - 1 }))),
    refuse('a token that expires before it was issued, still within the leeway', 'T10', token(HEADER, claims({ iat: NOW - 5, exp: NOW - 10 }))),
    refuse('a token that expired 30 seconds ago', 'T11', token(HEADER, claims({}, 'lb-01', NOW - 330))),
    refuse('a token that expired a minute ago', 'T11', token(HEADER, claims({}, 'lb-01', NOW - 360))),
    refuse('a token issued 31 seconds ahead', 'T11', token(HEADER, claims({}, 'lb-01', NOW + 31))),
    refuse('a token issued an hour ahead', 'T11', token(HEADER, claims({}, 'lb-01', NOW + 3_600))),
    refuse('a "nbf" 31 seconds ahead', 'T11', token(HEADER, claims({ nbf: NOW + 31 }))),
    refuse('a "nbf" an hour ahead', 'T11', token(HEADER, claims({ nbf: NOW + 3_600 }))),
  ]
}

/** The cases for who the visitor is (T12). */
function subjectCases(): CorpusTokenCase[] {
  const sub = (value: unknown): string => token(HEADER, claims({ sub: value }))
  const of128 = 'a1'.repeat(64)
  const of16 = 'abcdefghij012345'
  return [
    ok('a subject of 16 characters', 'T12', sub(of16), 'lb-01', of16),
    ok('a subject of 128 characters', 'T12', sub(of128), 'lb-01', of128),
    ok('a subject with hyphens and underscores', 'T12', sub('a-b_c-d_e-f_g-h_i-j'), 'lb-01', 'a-b_c-d_e-f_g-h_i-j'),
    refuse('a subject of 15 characters', 'T12', sub('abcdefghij01234')),
    refuse('a subject of 129 characters', 'T12', sub(`${of128}a`)),
    refuse('a subject that is empty', 'T12', sub('')),
    refuse('a subject with a space', 'T12', sub('has spaces and is long enough!')),
    refuse('a subject with a dot', 'T12', sub('has.a.dot.and.is.long.enough')),
    refuse('a subject with a letter outside ASCII', 'T12', sub('session-0123456789abcd\u00e9f')),
    refuse('a subject with a newline at the end', 'T12', sub(`${of16}\n`)),
    refuse('a subject that is a number', 'T12', sub(1_234_567_890_123_456)),
    refuse('a subject that is a list', 'T12', sub([SESSION])),
  ]
}

/** The cases for each system the site calls: the same token, for its own system and for the others. */
function systemCases(): CorpusTokenCase[] {
  const cases: CorpusTokenCase[] = []
  for (const system of SYSTEMS) {
    const own = token(HEADER, claims({}, system))
    cases.push(ok(`a token for ${system}, at ${system}`, 'T8', own, system))
    cases.push(refuse(`a token for ${system}, expired, at ${system}`, 'T11', token(HEADER, claims({}, system, NOW - 600)), system))
    cases.push(refuse(`a token for ${system}, signed by another key, at ${system}`, 'T5', token(HEADER, claims({}, system), createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), createHash('sha256').update('another key').digest()]), format: 'der', type: 'pkcs8' })), system))
    for (const other of SYSTEMS.filter(candidate => candidate !== system)) {
      cases.push(refuse(`a token for ${system}, at ${other}`, 'T8', own, other))
    }
  }
  return cases
}

/** Every token case. */
function tokenCases(): CorpusTokenCase[] {
  const good = token(HEADER, claims())
  return [
    ok('a token as the site mints it', 'T5', good),
    ...formCases(good),
    ...headerCases(),
    ...signatureCases(good),
    ...claimsFormCases(),
    ...audienceCases(),
    ...timeFormCases(),
    ...timeCases(),
    ...subjectCases(),
    ...systemCases(),
  ]
}

/** The cases for the Authorization header, around one good token (H1, H2). */
function authorizationCases(): CorpusHeaderCase[] {
  const good = token(HEADER, claims())
  const header = (name: string, rule: string, authorization: string | null, expect: 'ok' | 'refuse'): CorpusHeaderCase => ({ name, rule, system: 'lb-01', authorization, expect })
  return [
    header('Bearer and the token', 'H2', `Bearer ${good}`, 'ok'),
    header('bearer in lower case', 'H2', `bearer ${good}`, 'ok'),
    header('BEARER in capitals', 'H2', `BEARER ${good}`, 'ok'),
    header('bEaReR in mixed case', 'H2', `bEaReR ${good}`, 'ok'),
    header('three spaces after the scheme', 'H2', `Bearer   ${good}`, 'ok'),
    header('spaces before the scheme', 'H1', `  Bearer ${good}`, 'ok'),
    header('spaces after the token', 'H1', `Bearer ${good}  `, 'ok'),
    header('tabs around the header', 'H1', `\tBearer ${good}\t`, 'ok'),
    header('spaces and tabs around the header', 'H1', ` \t Bearer ${good} \t `, 'ok'),
    header('no header at all', 'H2', null, 'refuse'),
    header('an empty header', 'H2', '', 'refuse'),
    header('the scheme alone', 'H2', 'Bearer', 'refuse'),
    header('the scheme and a space', 'H2', 'Bearer ', 'refuse'),
    header('the scheme and spaces', 'H2', 'Bearer     ', 'refuse'),
    header('another scheme', 'H2', `Basic ${good}`, 'refuse'),
    header('the token alone', 'H2', good, 'refuse'),
    header('a tab after the scheme', 'H2', `Bearer\t${good}`, 'refuse'),
    header('spaces and then a tab before the token', 'H2', `Bearer  \t${good}`, 'refuse'),
    header('no space after the scheme', 'H2', `Bearer${good}`, 'refuse'),
    header('a word after the token', 'H2', `Bearer ${good} extra`, 'refuse'),
    header('a newline after the token', 'H1', `Bearer ${good}\n`, 'refuse'),
    header('a byte order mark before the scheme', 'H1', `\ufeffBearer ${good}`, 'refuse'),
    header('a no-break space after the scheme', 'H2', `Bearer\u00a0${good}`, 'refuse'),
    header('a colon after the scheme', 'H2', `Bearer: ${good}`, 'refuse'),
    header('another word for the scheme', 'H2', `Token ${good}`, 'refuse'),
    header('the token in quotes', 'H2', `Bearer "${good}"`, 'refuse'),
    header('a dot after the token', 'H2', `Bearer ${good}.`, 'refuse'),
    header('a token that is wrong', 'H2', `Bearer ${token(HEADER, claims({ aud: 'lb-02' }))}`, 'refuse'),
  ]
}

/** The cases for the site's key as it is configured (K1). */
function keyCases(): CorpusKeyCase[] {
  const raw = Buffer.from(publicKeyText, 'base64url')
  const key = (name: string, text: string, expect: 'ok' | 'refuse'): CorpusKeyCase => ({ name, rule: 'K1', key: text, expect })
  return [
    key('the key as `just gateway-token keygen` prints it', publicKeyText, 'ok'),
    key('an empty key', '', 'refuse'),
    key('a short key', 'c2hvcnQ', 'refuse'),
    key('a key of 31 bytes', b64u(raw.subarray(0, 31)), 'refuse'),
    key('a key of 33 bytes', b64u(Buffer.concat([raw, Buffer.from([1])])), 'refuse'),
    key('a key with padding', `${publicKeyText}=`, 'refuse'),
    key('a key with a space in it', `${publicKeyText.slice(0, 20)} ${publicKeyText.slice(20)}`, 'refuse'),
    key('a key with a space after it', `${publicKeyText} `, 'refuse'),
    key('a key with a space before it', ` ${publicKeyText}`, 'refuse'),
    key('a key with a plus sign', `${publicKeyText.slice(0, 20)}+${publicKeyText.slice(21)}`, 'refuse'),
    key('a key with a slash', `${publicKeyText.slice(0, 20)}/${publicKeyText.slice(21)}`, 'refuse'),
    key('a key with a letter outside ASCII', `${publicKeyText.slice(0, 20)}\u00e9${publicKeyText.slice(21)}`, 'refuse'),
    key('a key whose spare bits are not zero', nonCanonical(publicKeyText), 'refuse'),
  ]
}

/** Makes the whole corpus as the text of the file. */
function makeCorpus(): string {
  const corpus = {
    about: 'Signed visitor tokens and the verdict every verifier must give each: the TypeScript check in packages/common and the Python check in python/lb-common, which the Django, Flask and Node systems use. Made by packages/common/scripts/visitor-token-corpus.ts; do not edit by hand.',
    rules: RULES,
    now: NOW,
    publicKey: publicKeyText,
    tokens: tokenCases(),
    headers: authorizationCases(),
    keys: keyCases(),
  }
  return `${JSON.stringify(corpus, null, 2)}\n`
}

const made = makeCorpus()

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(CORPUS_FILE, 'utf8')
  }
  catch {
    // A missing file is as stale as a changed one.
  }
  if (current !== made) {
    console.error('test/fixtures/visitor-tokens.json is not what scripts/visitor-token-corpus.ts makes. Run `just visitor-tokens` and commit the result.')
    process.exit(1)
  }
  console.log('The visitor-token corpus is up to date.')
}
else {
  writeFileSync(CORPUS_FILE, made)
  console.log(`Wrote ${CORPUS_FILE.pathname}`)
}
