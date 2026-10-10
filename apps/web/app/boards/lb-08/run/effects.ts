// What the sandbox sent, and the proof that it sent each thing once. A write connector goes out
// under the key `<first run>:<step>`; a retry of the step, or a replay of the whole run, finds the
// key already delivered and sends nothing, and the log says so (`effect.sent` the first time,
// `effect.duplicate_suppressed` after). This module reads that out of the runs of one chain, a run
// and its replays, and sets it beside the sandbox's own table of deliveries, so the board can say
// plainly: three messages left, each one once, though a step failed twice and the run was replayed.
import type { ConnectorId, SentView, Values } from '@lb/contracts'

import type { RunModel } from './model'

/** One thing a write connector sent, and what happened around it. */
export interface EffectRow {
  nodeId: string
  connector: ConnectorId
  // The run that sent it, and the sandbox's id for it.
  sentInRun: string
  messageId: string
  // What was sent, as the sandbox recorded it; undefined until the sandbox's table has been read.
  content: Values | undefined
  // Attempts of the step that failed before it went out, in the run that sent it.
  failedAttempts: number
  // The replays that found the key already delivered and sent nothing.
  recognisedIn: string[]
}

/** The sandbox's side effects for a chain of runs. */
export interface EffectLedger {
  rows: EffectRow[]
  // Deliveries the sandbox recorded, `effect.sent` events in the logs and `effect.duplicate_suppressed` events.
  recorded: number
  sentEvents: number
  suppressed: number
  // Failed attempts of steps that went on to send, over the whole chain.
  failedBeforeSending: number
  // True when the sandbox holds exactly one delivery for each thing the logs say was sent.
  once: boolean
}

/** Counts the failed attempts of one step in one run. */
function failuresOf(run: RunModel, nodeId: string): number {
  return run.events.filter(event => event.type === 'step.failed' && event.nodeId === nodeId).length
}

/** Reads the effects out of a chain of runs (oldest first) and the sandbox's deliveries for that chain, when they have been read. */
export function ledgerOf(chain: readonly RunModel[], sent: readonly SentView[] | undefined): EffectLedger {
  const rows = new Map<string, EffectRow>()
  let sentEvents = 0
  let suppressed = 0
  for (const run of chain) {
    for (const event of run.events) {
      if (event.type === 'effect.sent') {
        sentEvents += 1
        rows.set(event.nodeId, {
          nodeId: event.nodeId,
          connector: event.connector,
          sentInRun: run.id,
          messageId: event.messageId,
          content: sent?.find(row => row.nodeId === event.nodeId)?.payload,
          failedAttempts: failuresOf(run, event.nodeId),
          recognisedIn: [],
        })
      }
      else if (event.type === 'effect.duplicate_suppressed') {
        suppressed += 1
        rows.get(event.nodeId)?.recognisedIn.push(run.id)
      }
    }
  }
  const list = [...rows.values()]
  const recorded = sent?.length ?? 0
  const distinct = new Set(sent?.map(row => row.nodeId))
  return {
    rows: list,
    recorded,
    sentEvents,
    suppressed,
    failedBeforeSending: list.reduce((total, row) => total + row.failedAttempts, 0),
    once: sent !== undefined && recorded === sentEvents && distinct.size === recorded,
  }
}
