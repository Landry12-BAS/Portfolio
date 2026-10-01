// Turning a description into a workflow: ask once, validate, and if the answer is refused,
// ask once more with the problems quoted. Two model calls at most, never a third.
//
//   1. generate  the model writes a workflow from the description (one gateway call)
//   2. validate  `validateWorkflow` decides, in plain code: the schema, then the whole
//                graph (one trigger, no loops, no dangling edges, every reference
//                resolves, bounded size). The model is never asked whether its own
//                workflow is valid.
//   3. repair    only when validation refused it: the model sees the problems and tries
//                again (a second gateway call). A second refusal is final.
//
// The outcome is either a workflow that passed every check or the problems that stopped
// it. Nothing in between is stored or run. Every step is a span of the current run, with
// labels and counts and never a word the visitor wrote, so the Scope can draw the trace.
// Call this inside a `runScope`: the gateway client labels each call with the run.
import type { Tracer } from '@lb/common'
import { validateWorkflow } from '@lb/contracts'
import type { ValidationResult } from '@lb/contracts'

import type { JsonModel } from './model.ts'
import type { DescribeWorkflow, GenerationOutcome } from './outcome.ts'
import { describeSystemPrompt, describeUserMessage, repairMessages } from './prompts.ts'
import type { ModelReply, PromptMessage } from './prompts.ts'

/** The most model calls describing one workflow can make: the first try and one repair. The gateway's cap for the run in routing.yaml allows one more. */
export const MAX_MODEL_CALLS = 2

/** What the pipeline is built from: the model to ask, and the tracer to record spans with. */
export interface PipelineDeps {
  model: JsonModel
  tracer: Tracer
}

/** One attempt: what the model replied, and what validation made of it. */
interface Attempt {
  reply: ModelReply
  checked: ValidationResult
}

/** The problem a reply that wasn't JSON at all has: there is no workflow to point at. */
const NOT_JSON: ValidationResult = {
  ok: false,
  issues: [{ code: 'invalid_value', path: 'graph', message: 'The reply was not a workflow in JSON form.' }],
}

/** Asks the model once and validates what it said, as a span named for the step. */
async function attempt(deps: PipelineDeps, name: 'generate' | 'repair', messages: readonly PromptMessage[]): Promise<Attempt> {
  return deps.tracer.span(name, async (span) => {
    const reply = await deps.model.ask(messages)
    const checked = reply.kind === 'json' ? validateWorkflow(reply.value) : NOT_JSON
    span.set('valid', checked.ok)
    span.set('issues', checked.ok ? 0 : checked.issues.length)
    return { reply, checked }
  })
}

/** Turns an attempt into the pipeline's outcome, given how many model calls it took. */
function outcomeOf(attempted: Attempt, modelCalls: number): GenerationOutcome {
  return attempted.checked.ok
    ? { status: 'accepted', graph: attempted.checked.graph, modelCalls }
    : { status: 'rejected', issues: attempted.checked.issues, modelCalls }
}

/** Builds the pipeline: a function that turns a description into an outcome, with its spans. */
export function createDescribeWorkflow(deps: PipelineDeps): DescribeWorkflow {
  return async description => deps.tracer.span('describe', async (span) => {
    const conversation: PromptMessage[] = [
      { role: 'system', content: describeSystemPrompt() },
      { role: 'user', content: describeUserMessage(description) },
    ]
    const first = await attempt(deps, 'generate', conversation)
    let outcome = outcomeOf(first, 1)
    if (!first.checked.ok) {
      const second = await attempt(deps, 'repair', repairMessages(conversation, first.reply, first.checked.issues))
      outcome = outcomeOf(second, 2)
    }
    span.set('calls', outcome.modelCalls)
    span.set('outcome', outcome.status)
    return outcome
  }, { kind: 'system.run' })
}
