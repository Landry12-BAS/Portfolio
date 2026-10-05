// A whole incident of LB-06, played on the mock back end's own simulator, for the tests of the
// board's pure functions: the real shop, the real SLO, the real agents' reference answers and the
// real log, so what the functions are tested on is what the board will be given. The mock ticks on a
// timer, so an incident takes a fraction of a second; each one is played once per test file and
// remembered.
import { Lb06Mock } from '@lb/api-clients/testing'
import type { Lb06Event, Lb06IncidentView, Lb06PostmortemView } from '@lb/contracts'

/** An incident, played to its end. */
export interface PlayedIncident {
  // The incident as the service shows it when it is over.
  view: Lb06IncidentView
  // Its whole log, in order.
  events: Lb06Event[]
  // Its postmortem, or undefined when it did not close.
  postmortem: Lb06PostmortemView | undefined
}

/** What a test may choose about the incident it plays. */
export interface PlayOptions {
  // The curated sample to play.
  sampleId?: string
  // What the visitor answers to each proposal. Rejecting makes the agents propose again.
  decision?: 'approve' | 'reject'
}

const played = new Map<string, Promise<PlayedIncident>>()

/** Waits a number of milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Plays an incident to its end, answering each proposal as asked, and returns what it left. */
async function play(options: PlayOptions): Promise<PlayedIncident> {
  const mock = new Lb06Mock(() => Date.now(), { tickMs: 4 })
  const session = 'session-unit-0123456789abcd'
  const started = mock.start(session, { from: 'sample', sampleId: options.sampleId ?? 'bad-deploy' })
  const first = started.body as Lb06IncidentView
  let rejected = 0
  for (let read = 0; read < 1_500; read += 1) {
    await wait(8)
    const view = mock.get(session, first.id).body as Lb06IncidentView
    if (view.pendingProposal) {
      const decision = options.decision ?? 'approve'
      if (decision === 'reject') rejected += 1
      mock.decide(session, first.id, view.pendingProposal.id, { decision: rejected > 1 ? 'approve' : decision })
    }
    if (['closed', 'aborted', 'failed'].includes(view.state)) {
      const events = (mock.events(session, first.id, new URLSearchParams('after=0')).body as { events: Lb06Event[] }).events
      const postmortem = view.state === 'closed' ? mock.postmortem(session, first.id).body as Lb06PostmortemView : undefined
      mock.reset()
      return { view, events, postmortem }
    }
  }
  mock.reset()
  throw new Error('The incident did not end in time.')
}

/** Plays an incident once per set of options in this test file, and returns what it left. */
export function playIncident(options: PlayOptions = {}): Promise<PlayedIncident> {
  const key = JSON.stringify(options)
  const found = played.get(key)
  if (found) return found
  const made = play(options)
  played.set(key, made)
  return made
}
