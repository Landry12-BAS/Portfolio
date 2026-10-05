// Trimming what the browser says about the page into evidence and into the data the re-planner is
// shown: the accessibility tree as text, cut to a bounded length, with control characters and anything
// that looks like markup removed. A page's text is untrusted (a hostile page may say "ignore your
// instructions"), so the snapshot is only ever handed on as data between markers the model is told
// about, never as instructions; this module only makes it small and plain.
import { LB07_LIMITS } from '@lb/contracts'

// Control and format characters, which a snapshot has no use for.
const CONTROL = /[\p{Cc}\p{Cf}]/gu

/** Cuts a text to `max` characters, ending with a note that it was cut. */
export function cutTo(text: string, max: number): string {
  if (text.length <= max) return text
  const note = '\n[cut]'
  return `${text.slice(0, Math.max(0, max - note.length))}${note}`
}

/** Makes a snapshot plain and bounded: in its compatibility form (so full-width brackets are brackets), with no control characters, no angle brackets, at most the limit. */
export function trimSnapshot(raw: string): string {
  const plain = raw.normalize('NFKC').replaceAll(CONTROL, ' ').replaceAll(/[<>]/g, ' ').replaceAll(/[ \t]+\n/g, '\n').replaceAll(/\n{3,}/g, '\n\n')
  return cutTo(plain.trim(), LB07_LIMITS.maxSnapshotChars)
}

/** Makes one line of a finding's detail plain and bounded. */
export function plainDetail(raw: string, max = 600): string {
  return cutTo(raw.replaceAll(CONTROL, ' ').replaceAll(/\s+/g, ' ').trim(), max)
}
