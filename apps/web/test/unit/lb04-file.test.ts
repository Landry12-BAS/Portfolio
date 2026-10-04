// Tests of how the board takes in a PDF the visitor chose: what is refused before anything is sent (an empty
// file, one over the size limit, one that does not begin the way a PDF does), the base64 the site's server
// forwards, and the sizes written for a visitor. The rules are the service's, so a file that passes here is
// one the service's own checks at the door will take.
import { LB04_LIMITS } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { fileProblemOf, formatSize, fromBase64, prepareFile, toBase64 } from '~/boards/lb-04/file'

const PDF_HEAD = new TextEncoder().encode('%PDF-1.7\n')

describe('what is refused before anything is sent', () => {
  it('is an empty file, a file past the size limit, and a file that does not begin with %PDF-', () => {
    expect(fileProblemOf(0, new Uint8Array())).toBe('empty')
    expect(fileProblemOf(LB04_LIMITS.maxFileBytes + 1, PDF_HEAD)).toBe('tooLarge')
    expect(fileProblemOf(500, new TextEncoder().encode('Dear sir, ...'))).toBe('notPdf')
    expect(fileProblemOf(500, new TextEncoder().encode('%PDF'))).toBe('notPdf')
  })

  it('takes a PDF of exactly the limit, as the service does', () => {
    expect(fileProblemOf(LB04_LIMITS.maxFileBytes, PDF_HEAD)).toBeUndefined()
    expect(fileProblemOf(1, PDF_HEAD)).toBeUndefined()
  })

  it('does not read a file that is too large: its size says enough', async () => {
    let read = false
    const big = {
      size: LB04_LIMITS.maxFileBytes + 1,
      arrayBuffer: () => {
        read = true
        return Promise.resolve(new ArrayBuffer(0))
      },
    } as unknown as Blob

    expect(await prepareFile(big)).toEqual({ problem: 'tooLarge' })
    expect(read).toBe(false)
  })

  it('reads a chosen file and says what is wrong with its bytes, or hands back the bytes and their base64', async () => {
    expect(await prepareFile(new Blob([]))).toEqual({ problem: 'empty' })
    expect(await prepareFile(new Blob(['hello, this is a letter']))).toEqual({ problem: 'notPdf' })
    const good = await prepareFile(new Blob([PDF_HEAD, new Uint8Array([1, 2, 3, 250, 251, 252])]))

    expect('file' in good && good.file.bytes.length).toBe(PDF_HEAD.length + 6)
    expect('file' in good && good.file.base64).toBe(Buffer.concat([PDF_HEAD, Buffer.from([1, 2, 3, 250, 251, 252])]).toString('base64'))
  })
})

describe('base64', () => {
  it('goes there and back for bytes of every value, in sizes past what one call can hold', () => {
    const bytes = new Uint8Array(300_000)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 7) % 256

    const text = toBase64(bytes)

    expect(text).toBe(Buffer.from(bytes).toString('base64'))
    expect(fromBase64(text)).toEqual(bytes)
  })

  it('is refused when the text is not base64', () => {
    expect(fromBase64('not base64!')).toBeUndefined()
  })
})

describe('a size for a visitor', () => {
  it('is whole kilobytes under a megabyte and megabytes with a decimal above, with a space that does not break', () => {
    expect(formatSize(42_253, 'en')).toBe('41 kB')
    expect(formatSize(100, 'en')).toBe('1 kB')
    expect(formatSize(2 * 1_048_576, 'en')).toBe('2.0 MB')
    expect(formatSize(2 * 1_048_576, 'cs')).toBe('2,0 MB')
  })
})
