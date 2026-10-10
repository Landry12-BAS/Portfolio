# @lb/contracts

The Zod schemas and types the LB systems share. The site imports them for its editor and
its run page, and the Node systems use them to check every boundary, so a workflow or a
run event means the same thing on both sides. It starts with LB-08 Automation Studio.

It is plain ESM TypeScript with no Node-only imports, so Node (which strips the types),
Vite and Nuxt load it as it is. A test fails the build if a Node import slips in.

## What it holds

| Area | What it gives |
|---|---|
| Workflow graph | `workflowGraphSchema`: nodes (trigger, action, condition, approval) and edges, with every choice a closed list |
| Validation | `validateWorkflow`: the schema and the structure of the whole graph in one list of issues, each with a stable code |
| Catalogue | `TRIGGER_EVENTS`, `CONNECTORS` and the lists of channels, mailboxes, endpoints and boards; `buildCatalogue` for the editor's palette |
| Language | `scanTemplate`, `renderTemplate`, `evaluateCondition`: how a step reads data, with no expressions and nothing to execute |
| Payloads | `triggerPayloadSchema`: the test payload of a run, checked against its event |
| Run events | `runEventSchema`: every state change of a run, each with a sequence number; the run page, the log and the replay all read them |
| API | The request bodies, the response views and the error body LB-08's API uses |
| Limits | `GRAPH_LIMITS` and `RUN_LIMITS`: the operating limits every layer enforces |

## One schema, three places

The same `workflowGraphSchema` checks what a model writes, what the API receives and what
the editor form holds. The model is never asked whether its own graph is valid.

```ts
import { validateWorkflow } from '@lb/contracts'

const result = validateWorkflow(untrusted)   // a model's answer, a request body or the form
if (!result.ok) {
  for (const issue of result.issues) console.log(issue.code, issue.path, issue.message)
}
```

An issue has a stable `code` (`unknown_connector`, `cycle`, `unavailable_reference` and so
on), a `path` into the graph and a message written as an instruction. Messages name ids,
fields and the allowed choices, and never repeat a visitor's words, so they can go to a
model for its one repair or into the editor as they are. When a graph fails the schema,
the structural checks still run on the nodes and edges that passed, so one repair can
fix every problem at once.

## What a graph can be

- **Four node types.** A *trigger* says what starts the run (one of seven events, such as a
  wholesale order or low stock). An *action* calls a connector. A *condition* compares one
  value and sends the run down its `true` or `false` branch. An *approval* waits for a
  person and goes down `approved` or `rejected`.
- **Five connectors, all sandboxed mocks:** stock check, Slack alert, email, webhook call
  and task. None can reach the network: a webhook names a business system from a list
  (`erp`, `crm`, `courier`, `accounting`) and never takes a URL, and an email goes to a
  role (`customer`, `roastery`, `purchasing`, `support`, `finance`), never an address.
- **Data by reference.** `{{trigger.totalEur}}` reads a field of the event's payload, and
  `{{check_stock.etaDays}}` reads an output of an earlier step. A reference must point at
  a value that exists on every path to the step that reads it.
- **Bounded.** At most 16 steps, 32 edges and 4 edges out of one step. There are no
  loops and no for-each, so a run takes at most as many steps as the graph has nodes.

## Tests

`pnpm --filter @lb/contracts test` runs them: a valid graph passes, each way a graph can
be wrong is refused with its own code, templates stay linear on hostile input, every
event kind round-trips, and every schema can be written as JSON Schema for the OpenAPI
file.
