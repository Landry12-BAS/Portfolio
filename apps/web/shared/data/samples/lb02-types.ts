// The shape of one of LB-02's curated samples: a short conversation, taken from the golden set so the
// demo shows exactly what the evals check. A sample is the visitor's side of the conversation (what
// they say, and when they wait), plus what the golden set says other visitors did before a message,
// which the demo can only reproduce in a recording or with a second tab (see the board's guide).

/** The languages an LB-02 sample is written in. */
export type ConversationLanguage = 'en' | 'cs'

/** One thing the visitor says, and how long they wait before saying it. */
export interface SampleTurn {
  // What the visitor types.
  say: string
  // Minutes to wait before saying it, such as the six it takes another visitor's hold to run out.
  waitMinutes: number
}

/** Something another visitor did to the calendar before one of the messages. */
export interface SampleWorldEvent {
  // The number of the message it happens before, counting from 1.
  beforeTurn: number
  // Whether the other visitor holds the slot (and lets the hold run out) or books it.
  otherVisitor: 'holds' | 'books'
  // The slot, as the seed lays it out: the offering, the day (1 is tomorrow) and the start in Prague time.
  offering: string
  day: number
  time: string
}

/** A curated conversation for LB-02's demo. */
export interface ConversationSample {
  // The case's ID in evals/lb02/golden.yaml, also the name of its recording.
  id: string
  language: ConversationLanguage
  // What the case covers, such as `happy_path` or `injection`.
  covers: readonly string[]
  turns: readonly SampleTurn[]
  world: readonly SampleWorldEvent[]
}
