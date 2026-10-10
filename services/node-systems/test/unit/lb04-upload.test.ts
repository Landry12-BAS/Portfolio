// Tests for the checks an uploaded file passes before anything is stored or any thread is started
// (pdf/upload.ts): it must be base64, within the size limit once decoded, and a PDF by its first
// bytes, and its name is only ever a label.
import { LB04_LIMITS } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { AppError } from '../../src/core/errors.ts'
import { decodeUpload, titleOf } from '../../src/modules/lb04/pdf/upload.ts'
import { seedBytes } from '../support/lb04.ts'

/** What decoding a file refuses with, as its status and code. */
function refusal(content: string): [number, string] | undefined {
  try {
    decodeUpload(content)
    return undefined
  }
  catch (error) {
    if (!(error instanceof AppError)) throw error
    return [error.status, error.code]
  }
}

describe('decoding an uploaded file', () => {
  it('returns the bytes of a PDF sent as base64', () => {
    const sample = seedBytes('wholesale-supply')

    const bytes = decodeUpload(Buffer.from(sample).toString('base64'))

    expect(bytes.equals(Buffer.from(sample))).toBe(true)
  })

  it('refuses a file that is not a PDF by its first bytes, with 415, whatever its name or its size', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(100)])
    const lateMagic = Buffer.concat([Buffer.from('  %PDF-1.7\n'), Buffer.alloc(100)])

    expect(refusal(png.toString('base64'))).toEqual([415, 'not_a_pdf'])
    expect(refusal(lateMagic.toString('base64'))).toEqual([415, 'not_a_pdf'])
    expect(refusal(Buffer.from('%PDF').toString('base64'))).toEqual([415, 'not_a_pdf'])
    expect(refusal(Buffer.from('<html></html>').toString('base64'))).toEqual([415, 'not_a_pdf'])
  })

  it('refuses text that is not base64: spaces, line breaks, URL-safe letters, a bad length or padding in the middle', () => {
    const good = Buffer.from('%PDF-1.7 and some more bytes after it').toString('base64')

    expect(refusal(`${good.slice(0, 8)} ${good.slice(8)}`)).toEqual([415, 'not_a_pdf'])
    expect(refusal(`${good.slice(0, 8)}\n${good.slice(8)}`)).toEqual([415, 'not_a_pdf'])
    expect(refusal(good.replace('+', '-').replace('/', '_') + '-_')).toEqual([415, 'not_a_pdf'])
    expect(refusal(good.slice(0, -1))).toEqual([415, 'not_a_pdf'])
    expect(refusal(`${good.slice(0, 4)}==${good.slice(4)}`)).toEqual([415, 'not_a_pdf'])
    expect(refusal('')).toEqual([415, 'not_a_pdf'])
  })

  it('refuses a file larger than the limit once decoded, with 413, and takes one exactly at it', () => {
    const header = Buffer.from('%PDF-1.7\n')
    const atLimit = Buffer.concat([header, Buffer.alloc(LB04_LIMITS.maxFileBytes - header.length)])
    const over = Buffer.concat([atLimit, Buffer.alloc(1)])

    expect(refusal(atLimit.toString('base64'))).toBeUndefined()
    expect(refusal(over.toString('base64'))).toEqual([413, 'file_too_large'])
  })
})

describe('the title a file gets in the visitor\'s list', () => {
  it('is the file\'s name, without the folders a path gives it, whichever way they are written', () => {
    expect(titleOf('supply agreement.pdf')).toBe('supply agreement.pdf')
    expect(titleOf('C:\\Users\\owner\\Documents\\supply.pdf')).toBe('supply.pdf')
    expect(titleOf('/home/owner/../etc/supply.pdf')).toBe('supply.pdf')
    expect(titleOf('../../secret.pdf')).toBe('secret.pdf')
  })

  it('has its white space made single, and invisible formatting characters taken out', () => {
    expect(titleOf('  supply \t  agreement\n.pdf ')).toBe('supply agreement .pdf')
    expect(titleOf('sup\u200Bply\uFEFF.pdf')).toBe('supply.pdf')
  })

  it('is cut to the limit in whole characters, and a character outside the basic plane is never cut in half', () => {
    const long = titleOf(`${'a'.repeat(200)}.pdf`)
    const astral = titleOf('\u{1F4C4}'.repeat(60))

    expect(long).toHaveLength(LB04_LIMITS.maxTitleLength)
    expect(astral.length).toBeLessThanOrEqual(LB04_LIMITS.maxTitleLength)
    expect(astral.isWellFormed()).toBe(true)
    expect([...astral].every(character => character === '\u{1F4C4}')).toBe(true)
  })

  it('falls back to a plain name when nothing visible is left', () => {
    expect(titleOf('')).toBe('contract.pdf')
    expect(titleOf('   ')).toBe('contract.pdf')
    expect(titleOf('folder/')).toBe('contract.pdf')
    expect(titleOf('\u200B\u200B')).toBe('contract.pdf')
  })
})
