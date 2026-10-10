// Grading a workflow, and an outcome, against a golden case's rules. Everything here is
// plain code over the graph: it reads node types, connectors, params and edges, and
// never asks a model whether an answer is good.
//
// A failure is a short sentence that starts with the name of the check that failed (for
// example `connectors: missing email`), so a report can count failures by check.
import { parseReference, scanTemplate } from '@lb/contracts'
import type { ActionNode, WorkflowGraph, WorkflowNode } from '@lb/contracts'

import type { GenerationOutcome } from '../generate/outcome.ts'
import type { GoldenCase } from './cases.ts'
import type { Expectation, StepKind } from './expectations.ts'

/** What kind of step a node is, for the `before` rule. */
function kindOf(node: WorkflowNode): StepKind | 'trigger' {
  return node.type === 'action' ? node.connector : node.type
}

/** Lists the action steps of a graph. */
function actions(graph: WorkflowGraph): ActionNode[] {
  return graph.nodes.filter((node): node is ActionNode => node.type === 'action')
}

/** Tells whether there is a path of edges from one step to another. */
function hasPath(graph: WorkflowGraph, from: string, to: string): boolean {
  const seen = new Set([from])
  const queue = [from]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const edge of graph.edges) {
      if (edge.from !== next || seen.has(edge.to)) continue
      if (edge.to === to) return true
      seen.add(edge.to)
      queue.push(edge.to)
    }
  }
  return false
}

/** Lists the texts of a step that may hold placeholders: an approval's message, or the text params of an action. */
function templatesIn(node: WorkflowNode): string[] {
  if (node.type === 'approval') return [node.message]
  if (node.type !== 'action') return []
  const texts: string[] = []
  for (const value of Object.values(node.params as Record<string, unknown>)) {
    if (typeof value === 'string') texts.push(value)
    else if (typeof value === 'object' && value !== null) texts.push(...Object.values(value).filter((inner): inner is string => typeof inner === 'string'))
  }
  return texts
}

/** Names the value a reference reads as `<source>.<field>`, where a step's id becomes its connector, or returns undefined. */
function generalise(reference: string, graph: WorkflowGraph): string | undefined {
  const parsed = parseReference(reference)
  if (!parsed) return undefined
  if (parsed.source === 'trigger') return reference
  const source = graph.nodes.find(node => node.id === parsed.source)
  return source?.type === 'action' ? `${source.connector}.${parsed.field}` : undefined
}

/** Counts how many times each value appears in a list. */
function counts<T>(values: readonly T[]): Map<T, number> {
  const tally = new Map<T, number>()
  for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1)
  return tally
}

/** Checks that every listed choice (repeats counting) is made by at least as many steps. */
function missingChoices(label: string, wanted: readonly string[] | undefined, made: readonly (string | undefined)[]): string[] {
  const have = counts(made)
  const failures: string[] = []
  for (const [choice, count] of counts(wanted ?? [])) {
    if ((have.get(choice) ?? 0) < count) failures.push(`${label}: missing ${choice}${count > 1 ? ` (${count} needed)` : ''}`)
  }
  return failures
}

/** Checks the trigger, the connectors used and the connectors forbidden. */
function structureFailures(rules: Expectation, graph: WorkflowGraph): string[] {
  const failures: string[] = []
  const trigger = graph.nodes.find(node => node.type === 'trigger')
  if (rules.trigger !== undefined && (trigger?.type !== 'trigger' || trigger.event !== rules.trigger)) {
    failures.push(`trigger: expected ${rules.trigger}, got ${trigger?.type === 'trigger' ? trigger.event : 'none'}`)
  }
  failures.push(...missingChoices('connectors', rules.connectors, actions(graph).map(node => node.connector)))
  for (const connector of rules.forbidConnectors ?? []) {
    if (actions(graph).some(node => node.connector === connector)) failures.push(`forbidConnectors: the workflow uses ${connector}`)
  }
  const stepCount = graph.nodes.length - 1
  if (rules.steps?.min !== undefined && stepCount < rules.steps.min) failures.push(`steps: ${stepCount} steps, at least ${rules.steps.min} needed`)
  if (rules.steps?.max !== undefined && stepCount > rules.steps.max) failures.push(`steps: ${stepCount} steps, at most ${rules.steps.max} allowed`)
  return failures
}

/** Checks the choices the steps make: channels, recipients, endpoints, boards, priorities and approvers. */
function choiceFailures(rules: Expectation, graph: WorkflowGraph): string[] {
  const steps = actions(graph)
  return [
    ...missingChoices('slackChannels', rules.slackChannels, steps.map(node => (node.connector === 'slack_alert' ? node.params.channel : undefined))),
    ...missingChoices('emailsTo', rules.emailsTo, steps.map(node => (node.connector === 'email' ? node.params.to : undefined))),
    ...missingChoices('endpoints', rules.endpoints, steps.map(node => (node.connector === 'webhook' ? node.params.endpoint : undefined))),
    ...missingChoices('boards', rules.boards, steps.map(node => (node.connector === 'create_task' ? node.params.board : undefined))),
    ...missingChoices('taskPriorities', rules.taskPriorities, steps.map(node => (node.connector === 'create_task' ? node.params.priority : undefined))),
    ...missingChoices('approvals', rules.approvals, graph.nodes.map(node => (node.type === 'approval' ? node.approver : undefined))),
  ]
}

/** Checks that each wanted condition exists: it reads one of the listed fields and compares as one of the listed ways. */
function conditionFailures(rules: Expectation, graph: WorkflowGraph): string[] {
  const failures: string[] = []
  for (const wanted of rules.conditions ?? []) {
    const found = graph.nodes.some((node) => {
      if (node.type !== 'condition') return false
      const field = generalise(node.field, graph)
      if (field === undefined || !wanted.fields.includes(field)) return false
      if (wanted.anyOf === undefined) return true
      return wanted.anyOf.some(comparison => comparison.op === node.op && comparison.value === node.value)
    })
    if (!found) {
      const how = wanted.anyOf?.map(comparison => `${comparison.op} ${String(comparison.value)}`).join(' or ')
      failures.push(`conditions: no condition on ${wanted.fields.join(' or ')}${how ? ` that is ${how}` : ''}`)
    }
  }
  return failures
}

/** Checks the order of steps, the values the texts read and the branches. */
function flowFailures(rules: Expectation, graph: WorkflowGraph): string[] {
  const failures: string[] = []
  for (const [first, second] of rules.before ?? []) {
    const firsts = graph.nodes.filter(node => kindOf(node) === first)
    const seconds = graph.nodes.filter(node => kindOf(node) === second)
    if (!firsts.some(a => seconds.some(b => a.id !== b.id && hasPath(graph, a.id, b.id)))) failures.push(`before: no ${first} step comes before a ${second} step`)
  }
  const read = new Set<string>()
  for (const node of graph.nodes) {
    for (const placeholder of templatesIn(node).flatMap(text => scanTemplate(text).placeholders)) {
      const value = generalise(placeholder, graph)
      if (value) read.add(value)
    }
    if (node.type === 'condition') {
      const value = generalise(node.field, graph)
      if (value) read.add(value)
    }
  }
  for (const use of rules.uses ?? []) {
    if (!read.has(`${use.connector}.${use.field}`)) failures.push(`uses: nothing reads ${use.connector}.${use.field}`)
  }
  if (rules.bothBranches === true) {
    const branching = graph.nodes.some((node) => {
      if (node.type !== 'condition' && node.type !== 'approval') return false
      const labels = new Set(graph.edges.filter(edge => edge.from === node.id).map(edge => edge.branch))
      return node.type === 'condition' ? labels.has('true') && labels.has('false') : labels.has('approved') && labels.has('rejected')
    })
    if (!branching) failures.push('bothBranches: no condition or approval leads somewhere on both of its outcomes')
  }
  return failures
}

/** Checks that none of the forbidden phrases appears anywhere in the workflow, ignoring case. */
function textFailures(rules: Expectation, graph: WorkflowGraph): string[] {
  const everything = JSON.stringify(graph).toLowerCase()
  return (rules.forbidText ?? []).filter(phrase => everything.includes(phrase.toLowerCase())).map(phrase => `forbidText: the workflow contains "${phrase}"`)
}

/** Grades one workflow against a case's rules, and returns every rule it breaks. */
export function gradeGraph(rules: Expectation, graph: WorkflowGraph): string[] {
  return [
    ...structureFailures(rules, graph),
    ...choiceFailures(rules, graph),
    ...conditionFailures(rules, graph),
    ...flowFailures(rules, graph),
    ...textFailures(rules, graph),
  ]
}

/** Grades what the pipeline did with a case's description: its outcome, and the workflow when it built one. */
export function gradeOutcome(entry: GoldenCase, outcome: GenerationOutcome): string[] {
  if (entry.kind === 'reject') {
    return outcome.status === 'rejected' ? [] : ['outcome: a workflow was stored for a request that must be refused']
  }
  if (outcome.status === 'rejected') {
    const reasons = [...new Set(outcome.issues.map(issue => issue.code))].join(', ')
    return entry.kind === 'build' ? [`outcome: expected a workflow, but it was refused (${reasons})`] : []
  }
  return gradeGraph(entry.expect, outcome.graph)
}
