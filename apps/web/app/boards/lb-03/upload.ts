// Getting a file ready to send: the quick checks the board makes on a file the visitor chose, before it
// sends anything, and the reading of a curated sample's file from the site's own static files. The checks
// are for the visitor's sake (a file that is certain to be refused is not worth uploading, and the refusal
// should come with a reason they can act on); they decide nothing. The site's server and the service check
// the same limits again, by the file's own first bytes and not by its name or the type the browser claims.
import type { InvoiceSample } from '#shared/data/samples/lb03-types'
import { LB03_SITE_FILE_BYTES } from '#shared/lb03-limits'

import { getBytes } from '~/board-kit/api'
import { badAnswerProblem } from '~/board-kit/problem'

import { sampleFileUrl } from './urls'

/** Why a chosen file is not worth sending. */
export type FileProblem = 'empty' | 'too_large' | 'unsupported'

/** What of a file the check needs: the same three things a browser's `File` has. */
export interface ChosenFile {
  name: string
  size: number
  type: string
}

// The extensions and the media types the service reads: PDF, PNG, JPEG and WebP.
const EXTENSIONS = /\.(?:pdf|png|jpe?g|webp)$/i
const MEDIA_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp'])

/** Checks a chosen file against what the site takes: not empty, not over 4 MiB, and a kind of file the reader knows by its name or type. */
export function checkChosenFile(file: ChosenFile): FileProblem | undefined {
  if (file.size === 0) return 'empty'
  if (file.size > LB03_SITE_FILE_BYTES) return 'too_large'
  if (!EXTENSIONS.test(file.name) && !MEDIA_TYPES.has(file.type.toLowerCase())) return 'unsupported'
  return undefined
}

/** Writes a size in bytes as megabytes or kilobytes with one decimal, in the visitor's language. */
export function formatSize(bytes: number, locale: string): string {
  const one = (value: number): string => new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(value)
  const nbsp = String.fromCharCode(0x00A0)
  return bytes >= 1_048_576 ? `${one(bytes / 1_048_576)}${nbsp}MB` : `${one(bytes / 1_024)}${nbsp}kB`
}

/**
 * Reads a curated sample's file from the site's static files, as a `File` the board can upload like a visitor's
 * own. The file's size must be the size the generated sample says it is: a deployment whose static files are
 * not the ones the golden set describes would otherwise be sending the wrong document.
 */
export async function loadSampleFile(sample: Pick<InvoiceSample, 'file' | 'mime' | 'bytes'>): Promise<File> {
  const bytes = await getBytes(sampleFileUrl(sample.file), LB03_SITE_FILE_BYTES)
  if (bytes.byteLength !== sample.bytes) throw badAnswerProblem()
  return new File([bytes], sample.file, { type: sample.mime })
}
