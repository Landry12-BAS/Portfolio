// The job that reviews one contract: open the file in a thread of its own, store its text, run the
// pipeline, and end the contract as done or as failed. The queue (queue.ts) calls it with the
// contract's id and which attempt this is.
//
// The job is built to be run again. Everything that cost something is saved as it is made (the text
// of the pages, then each model answer), so an attempt after a failure, a stalled worker or a sweep
// resumes where the last one stopped and never pays twice. Ending a contract is a single guarded
// transition, so a job that runs twice, or late, can't end a finished contract again or give a
// place back twice. What a failure means is decided in failures.ts: a retry is an error thrown to the
// queue, a final failure is an ended contract and a job that returns. A contract that keeps failing
// across retries and sweeps is ended after a bounded number of starts, and never tried for ever.
import { createRun, runScope, spanScope } from '@lb/common'
import type { Lb04FailureCode } from '@lb/contracts'

import { reviewContract } from '../analysis/pipeline.ts'
import type { ReviewHooks } from '../analysis/pipeline.ts'
import { ExtractionRefused, extractPdf } from '../pdf/extract.ts'
import type { Lb04Deps } from './deps.ts'
import { reactionTo, ReviewRetry } from './failures.ts'
import { completeContract, countAttempt, failContract, readContractForWork, readFileBytes, readPageTexts, readWorking, savePages, saveWorking, setState } from './store.ts'
import { recordReviewEnd, rootSpanIdOf } from './trace.ts'

/** Which attempt a job is on: its number (the first is 1), and whether it is the last the queue will give. */
export interface Attempt {
  number: number
  last: boolean
}

/** A contract as the job reads it. */
type Contract = NonNullable<Awaited<ReturnType<typeof readContractForWork>>>

/** Writes the root span of a contract whose review has just ended, from what the database now says of it. */
async function recordEnd(deps: Lb04Deps, contractId: string, outcome: string): Promise<void> {
  const contract = await readContractForWork(deps.db, contractId, deps.now())
  if (!contract) return
  await recordReviewEnd(deps, { contractId, sessionKey: contract.sessionKey, origin: contract.origin, startMs: contract.createdAt.getTime(), endMs: deps.now().getTime(), outcome, pages: contract.pages, modelCalls: contract.modelCalls })
}

/** Ends the contract as failed, and writes the root span if this call is the one that ended it. */
async function fail(deps: Lb04Deps, contractId: string, code: Lb04FailureCode): Promise<void> {
  if (await failContract(deps.db, contractId, code, deps.now())) await recordEnd(deps, contractId, code)
}

/**
 * Reads the text of the contract's pages: from the database when an earlier attempt stored it, and
 * otherwise by opening the file. Returns the pages, or the reason the file was refused.
 */
async function pagesOf(deps: Lb04Deps, contract: Contract): Promise<{ pages: { page: number, text: string }[] } | { refused: Lb04FailureCode }> {
  const stored = await readPageTexts(deps.db, contract.id)
  if (stored.length > 0) return { pages: stored }
  const bytes = await readFileBytes(deps.db, contract.id)
  if (!bytes) return { refused: 'internal' }
  return deps.tracer.span('extract text', async (span) => {
    try {
      const pages = await extractPdf(bytes, deps.config.extraction)
      span.set('pages', pages.length)
      span.set('characters', pages.reduce((total, page) => total + page.text.length, 0))
      await savePages(deps.db, contract.id, pages, deps.now())
      return { pages }
    }
    catch (error) {
      if (!(error instanceof ExtractionRefused)) throw error
      span.set('refused', error.code)
      // The error's name only, when there is one: its message and the file are the visitor's.
      if (error.detail !== undefined) deps.log.info({ contractId: contract.id, code: error.code, detail: error.detail }, 'a file was refused')
      return { refused: error.code }
    }
  })
}

/** The hooks the pipeline reports through: its states are the contract's, and what it saves is saved with the contract. */
function hooksFor(deps: Lb04Deps, contractId: string, attempt: Attempt): ReviewHooks {
  return {
    onState: async (state) => {
      await setState(deps.db, contractId, state, deps.now())
    },
    save: async (working) => {
      await saveWorking(deps.db, contractId, working, deps.now())
    },
    lastAttempt: attempt.last,
  }
}

/** The work of one attempt: extract, review, and end the contract as done. A file that is refused ends the contract as failed here, too. Errors go to the caller. */
async function attemptReview(deps: Lb04Deps, contract: Contract, attempt: Attempt): Promise<void> {
  if (!deps.review) {
    deps.log.error({ contractId: contract.id }, 'a review was queued in a process with no model gateway')
    await fail(deps, contract.id, 'internal')
    return
  }
  await setState(deps.db, contract.id, 'extracting', deps.now())
  const opened = await pagesOf(deps, contract)
  if ('refused' in opened) {
    await fail(deps, contract.id, opened.refused)
    return
  }
  const report = await reviewContract(
    { models: deps.review.models, guard: deps.review.guard, tracer: deps.tracer, playbook: deps.playbook },
    { contractId: contract.id, pages: opened.pages },
    await readWorking(deps.db, contract.id),
    hooksFor(deps, contract.id, attempt),
  )
  if (await completeContract(deps.db, contract.id, report, deps.now())) await recordEnd(deps, contract.id, 'done')
}

/** Does one attempt, and turns what goes wrong into what the queue needs: a contract ended as failed, or an error that asks for another attempt. */
async function review(deps: Lb04Deps, contract: Contract, attempt: Attempt): Promise<void> {
  try {
    await attemptReview(deps, contract, attempt)
  }
  catch (error) {
    const reaction = reactionTo(error)
    if (reaction?.kind === 'fail') {
      await fail(deps, contract.id, reaction.code)
      return
    }
    // Another try may help, unless it is the last: then the visitor is told so, whatever went wrong.
    if (attempt.last) {
      deps.log.warn({ contractId: contract.id, error: error instanceof Error ? error.name : 'unknown' }, 'a review ran out of attempts')
      await fail(deps, contract.id, reaction ? 'analysis_unavailable' : 'internal')
      return
    }
    throw new ReviewRetry(reaction?.kind === 'retry' ? reaction.retryAfterSeconds : undefined)
  }
}

/**
 * Reviews one contract. Does nothing for a contract that is gone, expired or already ended, so a
 * job that runs twice is harmless. Throws `ReviewRetry` when the queue should try again, and returns
 * when the contract has ended, whatever the way.
 */
export async function reviewJob(deps: Lb04Deps, contractId: string, attempt: Attempt): Promise<void> {
  const contract = await readContractForWork(deps.db, contractId, deps.now())
  if (!contract || contract.state === 'done' || contract.state === 'failed') return
  const run = createRun({ system: 'lb-04', runId: contract.id, session: contract.sessionKey, dataClass: contract.origin === 'sample' ? 'synthetic' : 'visitor' })
  await runScope(run, async () => spanScope(rootSpanIdOf(contract.id), async () => {
    // A contract that has been started more often than the queue and the sweep between them should ever need is ended, not tried again.
    if (await countAttempt(deps.db, contract.id) > deps.config.maxAttempts * 2) {
      deps.log.warn({ contractId: contract.id }, 'a review was started too often')
      await fail(deps, contract.id, 'internal')
      return
    }
    await review(deps, contract, attempt)
  }))
}
