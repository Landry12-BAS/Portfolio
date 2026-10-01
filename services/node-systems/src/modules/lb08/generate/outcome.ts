// What describing a process comes to: a workflow that passed every check, or a refusal
// that says why. Nothing in between is ever stored or run. The live eval grades these
// outcomes against the golden set, and the API turns them into responses.
import type { WorkflowGraph, WorkflowIssue } from '@lb/contracts'

/**
 * The outcome of turning a description into a workflow. `modelCalls` counts the
 * gateway calls it took, the repair included, so the datasheet's calls-per-workflow
 * figure can be measured from real runs.
 */
export type GenerationOutcome
  = | { status: 'accepted', graph: WorkflowGraph, modelCalls: number }
    | { status: 'rejected', issues: WorkflowIssue[], modelCalls: number }

/** Something that turns a plain-language description into an outcome: the live pipeline, or a fake in a test. */
export type DescribeWorkflow = (description: string) => Promise<GenerationOutcome>
