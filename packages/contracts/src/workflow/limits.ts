// The operating limits of LB-08 Automation Studio, in one place. The graph schema, the
// validator, the editor form on the site and the service all read these numbers, so a
// limit can't be loosened in one layer and forgotten in another.

/**
 * Bounds on one workflow graph. They keep a description, or a model's answer to it,
 * from asking the engine for unbounded work: there are no loops and no for-each, so
 * the number of steps a run can take is at most `maxNodes`.
 */
export const GRAPH_LIMITS = {
  // Nodes in one graph, the trigger included.
  maxNodes: 16,
  // Edges in one graph.
  maxEdges: 32,
  // Edges leaving one node: the widest fan-out allowed.
  maxFanOut: 4,
  // Characters in a workflow's name, a node's label, and any text with {{placeholders}}.
  maxNameLength: 80,
  maxLabelLength: 60,
  maxTemplateLength: 400,
  // Characters in the plain-language description a visitor writes.
  maxDescriptionLength: 1_000,
  // Entries in a webhook's `fields`.
  maxWebhookFields: 8,
} as const

/** The limits on running workflows (the LB-08 datasheet's operating limits). */
export const RUN_LIMITS = {
  // Workflow runs per visitor per day, a replay counting as a run.
  runsPerVisitorPerDay: 10,
  // Workflows a visitor may describe to the model per day. Each takes one model call
  // and, at most, one repair.
  generationsPerVisitorPerDay: 10,
  // Attempts a step gets before it goes to the dead-letter queue: the first try and
  // two retries, with exponential backoff between them.
  maxAttempts: 3,
  // The most failures a visitor may inject into one step, for the make-it-fail demo.
  maxInjectedFailures: 5,
  // Workflows a visitor may keep at once, and versions one workflow may hold.
  maxWorkflowsPerVisitor: 20,
  maxVersionsPerWorkflow: 30,
  // How long a visitor's workflows, runs and sandbox deliveries are kept.
  retentionHours: 24,
} as const
