// How the board lines up what the service recorded of a document's run with the datasheet's chain of nine
// steps. The service saves each pipeline step as it ends (queue, ocr, injection check, extract, validate,
// repair, place fields, check duplicates, journal entry), with its time and a few counts. The datasheet's
// chain has the same steps in the same order, less the queue the document waits in, and one more at the
// end: export, which is the visitor's to do and not a step of the pipeline. A step that is missing says
// something too: a document that failed never reached the later ones, and a clean document needed no repair.
import type { InvoiceDocument, Step } from './schemas'

/** What became of one link of the chain. */
export type ChainState = 'done' | 'failed' | 'skipped' | 'notReached' | 'ready' | 'blocked'

/** One link of the datasheet's chain, with the step the service recorded for it, if any. */
export interface ChainRow {
  // The chain's position, from 0, which is also where its label is in the datasheet.
  index: number
  // The name the service gives the step, or undefined for the export, which is not a step of the pipeline.
  name: string | undefined
  step: Step | undefined
  state: ChainState
}

// The pipeline's step names, in the order of the datasheet's chain. The last link, export, is not a step.
const CHAIN_STEPS: readonly (string | undefined)[] = [
  'ocr',
  'injection check',
  'extract',
  'validate',
  'repair',
  'place fields',
  'check duplicates',
  'journal entry',
  undefined,
]

/** Says what became of a link of the chain, from the step the service recorded for it and how the document ended. */
function stateOf(step: Step | undefined, name: string | undefined, document: InvoiceDocument): ChainState {
  if (name === undefined) {
    if (document.state !== 'ready') return 'notReached'
    return document.can_export ? 'ready' : 'blocked'
  }
  if (step !== undefined) return step.status === 'ok' ? 'done' : step.status === 'error' ? 'failed' : 'skipped'
  // A document that is ready skipped the steps it did not need (a repair when no check failed); one that failed never got to them.
  return document.state === 'ready' ? 'skipped' : 'notReached'
}

/** Lines up the document's recorded steps with the chain, one row for each link. */
export function chainRows(document: InvoiceDocument): ChainRow[] {
  return CHAIN_STEPS.map((name, index) => {
    const step = name === undefined ? undefined : document.steps.find(candidate => candidate.name === name)
    return { index, name, step, state: stateOf(step, name, document) }
  })
}

/** Finds the step in which a document waited for a reader, which is not a link of the chain but is worth saying. */
export function queueStep(document: InvoiceDocument): Step | undefined {
  return document.steps.find(step => step.name === 'queue')
}

/** The facts a step recorded, such as the pages it read or the checks it ran, in the order the service listed them. */
export function factsOf(step: Step): [string, string | number | boolean][] {
  return Object.entries(step.detail)
}
