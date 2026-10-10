// Where a document is, in words the board can show without guessing. The service tells the board one
// of seven states (uploaded, ocr, extract, validate, repair, ready, failed) and, once a step is done,
// what that step did; the board shows exactly that. It does not estimate a percentage: how long a
// document takes depends on the queue, the models and the page, and the honest things to say are which
// stage it is in, how many documents are ahead of it, and how long it has been going.
import type { DocumentState, InvoiceDocument, Step } from './schemas'

/** The stages a document is shown going through. Reading the text and extracting the fields are one stage each. */
export const STAGES = ['uploaded', 'ocr', 'extract', 'validate', 'repair', 'ready'] as const
/** A stage of a reading. */
export type Stage = (typeof STAGES)[number]

/** How one stage stands for a document. */
export type StageStatus = 'done' | 'current' | 'waiting' | 'skipped' | 'failed'

/** The states in which a document's pipeline is over. */
const FINAL: ReadonlySet<DocumentState> = new Set(['ready', 'failed'])

/** Tells whether a document's pipeline is over: it is ready, or it has no result. */
export function isFinal(state: DocumentState): boolean {
  return FINAL.has(state)
}

/** Tells whether a document ended with a result to look at, which may still carry failed checks. */
export function isReady(document: InvoiceDocument | undefined): boolean {
  return document !== undefined && document.state === 'ready'
}

/** Finds where in the stages a state is. `failed` has no place of its own: it stopped at the stage the steps say. */
function placeOf(state: DocumentState): number {
  return state === 'failed' ? STAGES.length : STAGES.indexOf(state)
}

/** Tells whether a document's steps include one by this name, such as `repair`. */
function hasStep(steps: readonly Step[], name: string): boolean {
  return steps.some(step => step.name === name)
}

/** Finds the last stage a failed document reached, from the steps it recorded before it stopped. */
export function stoppedAt(steps: readonly Step[]): Stage {
  const failedStep = steps.find(step => step.status === 'error')
  if (failedStep === undefined) return 'extract'
  if (failedStep.name === 'ocr' || failedStep.name === 'queue') return 'ocr'
  if (failedStep.name === 'validate' || failedStep.name === 'place fields' || failedStep.name === 'check duplicates' || failedStep.name === 'journal entry') return 'validate'
  if (failedStep.name === 'repair') return 'repair'
  return 'extract'
}

/** Tells how a stage stands for a document: done, the one it is in, waiting, skipped (the repair a clean document did not need) or the one it failed at. */
export function stageStatus(document: Pick<InvoiceDocument, 'state' | 'steps'>, stage: Stage): StageStatus {
  const here = placeOf(document.state)
  const place = STAGES.indexOf(stage)
  if (document.state === 'failed') {
    const stopped = STAGES.indexOf(stoppedAt(document.steps))
    if (place < stopped) return 'done'
    return place === stopped ? 'failed' : 'waiting'
  }
  if (document.state === 'ready') {
    if (stage === 'repair' && !hasStep(document.steps, 'repair')) return 'skipped'
    return 'done'
  }
  if (place < here) return stage === 'repair' && !hasStep(document.steps, 'repair') ? 'skipped' : 'done'
  return place === here ? 'current' : 'waiting'
}

/** Counts the whole seconds from a moment to another, never less than nothing. */
export function secondsSince(startedAt: number, now: number): number {
  return Math.max(Math.floor((now - startedAt) / 1_000), 0)
}

/** How long, in seconds, a document may take in all, from the service's own limits: the OCR, the model calls and the rest. */
export const DOCUMENT_GIVE_UP_SECONDS = 300
/** After this many seconds a document is taking longer than usual. */
export const SLOW_AFTER_SECONDS = 45
