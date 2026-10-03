// The bug catalogue, read strictly from data/seed/lb07/bugs.yaml: what each switchable bug of the
// staging shop is, where a correct run finds it, and the truth a finding is matched against when the
// golden set is graded. The ids are the closed list in @lb/contracts, so a catalogue that names a bug
// the shop does not implement, or leaves one out, fails here.
import { LB07_BUG_IDS, LB07_ENGINES, LB07_FINDING_KINDS } from '@lb/contracts'
import type { Lb07BugId, Lb07BugView, Lb07Finding } from '@lb/contracts'
import { z } from 'zod'

import { DataFileError, readDataFile } from '../../../core/data-files.ts'

/** What a correct finding of a bug looks like: its kind, and where given, its engine, its shop path, its axe rule and words of its detail. */
export const truthSchema = z.strictObject({
  kind: z.enum(LB07_FINDING_KINDS),
  engine: z.enum(LB07_ENGINES).optional(),
  path: z.string().regex(/^\/[a-z0-9/.-]{0,80}$/).optional(),
  rule: z.string().regex(/^[a-z0-9-]{1,60}$/).optional(),
  detail: z.array(z.string().min(1).max(60)).max(4).optional(),
})
/** The truth of one bug. */
export type Truth = z.infer<typeof truthSchema>

const bugSchema = z.strictObject({
  id: z.enum(LB07_BUG_IDS),
  title: z.string().trim().min(3).max(80),
  summary: z.string().trim().min(10).max(300),
  surfaces: z.array(z.enum(LB07_FINDING_KINDS)).min(1).max(5),
  truth: truthSchema,
})

const fileSchema = z.strictObject({ bugs: z.array(bugSchema).min(1).max(LB07_BUG_IDS.length) })

/** One bug of the catalogue. */
export type BugEntry = z.infer<typeof bugSchema>

/** The catalogue: every bug by its id. */
export type BugCatalogue = ReadonlyMap<Lb07BugId, BugEntry>

/** Reads the catalogue from the seed folder, and checks it names every bug of the closed list exactly once. */
export function readBugCatalogue(seedDirectory: string): BugCatalogue {
  const path = `${seedDirectory}/lb07/bugs.yaml`
  const file = readDataFile(path, fileSchema)
  const catalogue = new Map<Lb07BugId, BugEntry>()
  for (const bug of file.bugs) {
    if (catalogue.has(bug.id)) throw new DataFileError(`${path} lists the bug ${bug.id} twice.`)
    if (!bug.surfaces.includes(bug.truth.kind)) throw new DataFileError(`${path}: the bug ${bug.id} says its truth is a ${bug.truth.kind}, which is not among its surfaces.`)
    catalogue.set(bug.id, bug)
  }
  for (const id of LB07_BUG_IDS) {
    if (!catalogue.has(id)) throw new DataFileError(`${path} does not describe the bug ${id}, which the shop can switch on.`)
  }
  return catalogue
}

/** The catalogue as the API shows it, in the closed list's order. */
export function bugViews(catalogue: BugCatalogue): Lb07BugView[] {
  return LB07_BUG_IDS.flatMap((id) => {
    const bug = catalogue.get(id)
    return bug ? [{ id: bug.id, title: bug.title, summary: bug.summary, surfaces: bug.surfaces }] : []
  })
}

/** Tells whether a finding is what a bug's truth describes. */
export function matchesTruth(truth: Truth, finding: Lb07Finding): boolean {
  if (finding.kind !== truth.kind) return false
  if (truth.engine !== undefined && finding.engine !== truth.engine) return false
  if (truth.path !== undefined && finding.path !== truth.path) return false
  if (truth.rule !== undefined && finding.rule !== truth.rule) return false
  if (truth.detail !== undefined && !truth.detail.every(words => finding.detail.includes(words))) return false
  return true
}
