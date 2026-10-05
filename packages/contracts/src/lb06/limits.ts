// LB-06 Incident Commander's operating limits and closed lists: the services of the simulated shop,
// the metrics each one reports, the faults a visitor may inject, the actions an agent may propose,
// the states of an incident and the kinds of event its log holds. The service enforces the numbers,
// the board shows them and the datasheet promises them, so they live in one place. Every list is
// closed because the model's answers, the simulator and the board all name its members, and a name
// outside a list is an error everywhere.

/** LB-06's limits. The datasheet (apps/web/shared/data/systems.ts) promises the incidents a day, the step cap and the human approval. */
export const LB06_LIMITS = {
  // How many incidents a visitor may start in a day.
  incidentsPerVisitorPerDay: 1,
  // The most agent steps (model calls) an incident may spend: the orchestrator stops asking at this count.
  stepCap: 15,
  // How many incidents the service runs at once, across every visitor: a running simulation costs CPU.
  maxConcurrentIncidents: 8,
  // Simulated minutes of calm before the fault, so the detector and the agents have a baseline.
  baselineMinutes: 30,
  // The most simulated minutes an incident may run before it is ended as timed out.
  maxSimulatedMinutes: 180,
  // The most wall-clock milliseconds an incident may live, whatever its simulated clock says.
  maxWallMs: 8 * 60_000,
  // Wall-clock milliseconds between two simulated minutes while an incident runs.
  tickMs: 2_000,
  // Simulated minutes of a healthy SLO before an incident counts as recovered.
  recoveryMinutes: 5,
  // How long an incident, its log and its postmortem are kept.
  keptHours: 24,
  // The most characters of a visitor's own text in a fault's parameters: a deploy's version label, a flag's name.
  maxParamLength: 40,
  // The most hypotheses the commander may rank, and the most evidence references one may carry.
  maxHypotheses: 5,
  maxEvidencePerHypothesis: 6,
  // The most proposals an incident may go through before the agents stop and the incident is ended.
  maxProposals: 3,
  // The most events the log holds, and the most minutes of series an answer carries.
  maxEvents: 600,
  maxSeriesMinutes: 240,
  // The most rows a read-only tool returns to an agent.
  maxToolRows: 12,
  // The most characters of model-written postmortem prose.
  maxPostmortemChars: 2_400,
} as const

/** The services of the simulated shop, in dependency order from the edge to the data. */
export const LB06_SERVICES = ['web', 'cart', 'payment', 'inventory', 'database', 'cache'] as const
/** One service of the shop. */
export type Lb06Service = (typeof LB06_SERVICES)[number]

/** The metrics every service reports each simulated minute. */
export const LB06_METRICS = ['request_rate', 'error_rate', 'latency_p50', 'latency_p95', 'latency_p99', 'saturation', 'memory_mb'] as const
/** One metric of a service. */
export type Lb06Metric = (typeof LB06_METRICS)[number]

/** The faults a visitor may inject: "break the shop". */
export const LB06_FAULTS = ['bad_deploy', 'slow_payment', 'memory_leak', 'cache_stampede'] as const
/** One fault. */
export type Lb06Fault = (typeof LB06_FAULTS)[number]

/** The actions an agent may propose, a closed list: nothing outside it can be proposed, approved or applied. */
export const LB06_ACTIONS = ['rollback', 'restart', 'scale', 'flush_cache', 'flip_flag'] as const
/** One kind of action. */
export type Lb06ActionKind = (typeof LB06_ACTIONS)[number]

/** The feature flags the shop has. A visitor may name one more through a fault's parameters. */
export const LB06_FLAGS = ['payment-provider-fallback', 'inventory-prefetch', 'request-coalescing', 'checkout-v2'] as const
/** One of the shop's flags. */
export type Lb06Flag = (typeof LB06_FLAGS)[number]

/** The steps an incident goes through, in order; `aborted` and `failed` can follow any of them. */
export const LB06_STATES = ['baseline', 'detecting', 'investigating', 'awaiting_approval', 'remediating', 'verifying', 'writing_postmortem', 'closed', 'aborted', 'failed'] as const
/** One state of an incident. */
export type Lb06State = (typeof LB06_STATES)[number]

/** The three specialist agents the commander delegates to. */
export const LB06_AGENTS = ['commander', 'logs', 'metrics', 'deploys'] as const
/** One agent. */
export type Lb06Agent = (typeof LB06_AGENTS)[number]

/** The read-only tools the specialists may call over the simulator. */
export const LB06_TOOLS = ['query_logs', 'query_metrics', 'list_deploys'] as const
/** One tool. */
export type Lb06Tool = (typeof LB06_TOOLS)[number]

/** The kinds of event an incident's log holds: every state change of the simulator and of the incident is one. */
export const LB06_EVENT_KINDS = [
  'incident.started',
  'tick',
  'fault.injected',
  'alert.fired',
  'investigation.started',
  'agent.step',
  'evidence.discarded',
  'hypotheses.ranked',
  'proposal.made',
  'proposal.approved',
  'proposal.rejected',
  'remediation.applied',
  'slo.recovered',
  'postmortem.written',
  'incident.closed',
  'incident.aborted',
  'incident.failed',
] as const
/** One kind of event. */
export type Lb06EventKind = (typeof LB06_EVENT_KINDS)[number]

/** Why an incident ended before it closed. */
export const LB06_END_REASONS = ['visitor', 'timed_out', 'step_cap', 'proposals_spent', 'agents_unavailable', 'lost'] as const
/** One reason an incident ended early. */
export type Lb06EndReason = (typeof LB06_END_REASONS)[number]

/** What a visitor's text in a fault's parameters may hold: letters, digits, spaces and a little punctuation. */
export const LB06_PARAM_PATTERN = /^[\w .,:;!?'"()/-]{1,40}$/
