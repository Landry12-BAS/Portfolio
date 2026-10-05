// What a screenshot of LB-07's evidence must be before the site shows it, in one place for the two that
// show one: the site's server, which answers a live run's screenshot as a picture of its own (the image
// route, server/handlers/lb07-evidence-image.ts), and the board's replay, which shows a recorded one as a
// `data:` address. The service sends a screenshot as base64 inside JSON; it is shown only if it decodes
// cleanly, is no larger than the service keeps, and starts with the PNG signature, so nothing that is not
// a PNG is ever handed to the browser's image decoder as one.
import { LB07_LIMITS } from '@lb/contracts'

/** The eight bytes every PNG file starts with. */
export const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
/** The largest screenshot the service keeps, and so the largest the site shows. */
export const MAX_SCREENSHOT_BYTES = LB07_LIMITS.maxScreenshotBytes

// Base64 as the service writes it: the standard alphabet, padded to a multiple of four.
const BASE64 = /^[A-Z0-9+/]*={0,2}$/i

/** The path of a live run's screenshot as a picture, on the site's own origin. */
export function screenshotPath(runId: string, evidenceId: string): string {
  return `/api/lb07/runs/${encodeURIComponent(runId)}/evidence/${encodeURIComponent(evidenceId)}/image`
}

/** Tells whether bytes start with the PNG signature. */
export function hasPngSignature(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
}

/** Decodes base64 strictly: anything outside the alphabet, or with the wrong length, is not decoded at all. */
export function decodeBase64(text: string): Uint8Array | undefined {
  if (text.length % 4 !== 0 || !BASE64.test(text)) return undefined
  let binary: string
  try {
    binary = atob(text)
  }
  catch {
    return undefined
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** The bytes of a screenshot sent as base64, when they are a PNG the site may show; undefined otherwise. */
export function screenshotBytes(base64: string): Uint8Array | undefined {
  // Base64 takes four characters for every three bytes, so a longer text cannot be a screenshot the service keeps.
  if (base64.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4) return undefined
  const bytes = decodeBase64(base64)
  if (!bytes || bytes.length > MAX_SCREENSHOT_BYTES || !hasPngSignature(bytes)) return undefined
  return bytes
}
