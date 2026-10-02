// How LB-02's curated samples are run for a recording: open a conversation over the WebSocket as one
// synthetic visitor, say the sample's messages one by one, and keep what the board would have been
// told, exchange by exchange (app/boards/lb-02/recorded.ts says how a conversation is kept). The
// calendar the conversation opened on is read first; each message is kept with the concierge's
// reply and the calendar changes that reached the conversation since its last reply.
//
// A sample can say that other visitors do something before a message (the golden set's `world`):
// another visitor holds or books a slot, and a hold may run out while the visitor waits. The runner
// does that with a second synthetic visitor, who talks to the concierge for the slot like any
// visitor, and then checks that the calendar the first visitor watches shows the slot taken. If it
// does not (a real model asked for something else), nothing is recorded: a replay must show what
// the sample says it shows.
//
// The visitor's token goes in the hello frame, as the board does, and is never kept: the recording
// holds only which conversation the hello asked for. It costs one conversation for the sample
// (three to five model calls a message) and, for samples with other visitors, another for each.
import type { Exchange } from '@lb/contracts'

import { pragueDate } from '../../app/boards/lb-02/calendar.ts'
import { RECORDED_PATHS } from '../../app/boards/lb-02/recorded.ts'
import { calendarSchema, conversationSchema, offeringsSchema } from '../../app/boards/lb-02/schemas.ts'
import type { Offering } from '../../app/boards/lb-02/schemas.ts'
import { helloText, messageText, parseServerFrame } from '../../app/boards/lb-02/wire.ts'
import type { CalendarEvent, ReadyEvent, ReplyEvent, ServerEvent } from '../../app/boards/lb-02/wire.ts'
import { LB02_SAMPLES } from '../../shared/data/samples/lb02.ts'
import type { SampleWorldEvent } from '../../shared/data/samples/lb02-types.ts'
import type { Backend } from './backend.ts'
import type { RecordedRun } from './record.ts'

// How long the recorder waits for a connection to open and say hello, and for the concierge to answer
// one message (a slow model, a slow tool).
const OPEN_PATIENCE_MS = 30_000
const ANSWER_PATIENCE_MS = 180_000
// How long it waits for the calendar change another visitor's action makes to reach the first visitor's connection.
const CHANGE_PATIENCE_MS = 10_000

// Where the conversation listens on the API's host (services/django-systems/README.md).
const SOCKET_PATH = '/ws/lb02/'

/** Makes the WebSocket address of the API: its own origin, with `ws:` or `wss:` for the scheme. */
function socketUrl(api: URL): string {
  const url = new URL(SOCKET_PATH, api)
  url.protocol = api.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

/** A conversation of one synthetic visitor, driven over the WebSocket the way the board drives it. */
class Visit {
  readonly #socket: WebSocket
  readonly #events: ServerEvent[] = []
  readonly #wake: (() => void)[] = []
  #closed: number | undefined
  #failed: string | undefined
  // The calendar changes that arrived since the last reply, which the next reply is kept with.
  readonly #calendar: CalendarEvent[] = []

  /** Starts connecting to the API's WebSocket. Nothing is sent until `hello`. */
  constructor(backend: Backend) {
    this.#socket = new WebSocket(socketUrl(backend.apiUrl))
    this.#socket.addEventListener('message', (event) => {
      const parsed = parseServerFrame(event.data)
      if (parsed) this.#events.push(parsed)
      else this.#failed = 'The concierge sent something the board does not understand, which the board would have closed the connection for.'
      this.#wakeAll()
    })
    this.#socket.addEventListener('open', () => this.#wakeAll())
    this.#socket.addEventListener('close', (event) => {
      this.#closed = event.code
      this.#wakeAll()
    })
  }

  /** Wakes everything that is waiting for an event. */
  #wakeAll(): void {
    for (const wake of this.#wake.splice(0)) wake()
  }

  /** Waits until something happens (an event, a close) or the time is up. */
  async #something(untilMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(untilMs - Date.now(), 0))
      this.#wake.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /** Takes the next event the concierge sent, waiting for it. */
  async #next(patienceMs: number): Promise<ServerEvent> {
    const until = Date.now() + patienceMs
    for (;;) {
      if (this.#failed) throw new Error(this.#failed)
      const event = this.#events.shift()
      if (event) return event
      if (this.#closed !== undefined) throw new Error(`The connection closed (code ${this.#closed}) while the recorder was waiting for the concierge.`)
      if (Date.now() >= until) throw new Error('The concierge did not answer in time.')
      await this.#something(until)
    }
  }

  /** Opens the conversation: waits for the connection, says hello with the visitor's token, and returns the `ready` event. */
  async hello(backend: Backend, conversation: string | null): Promise<ReadyEvent> {
    const until = Date.now() + OPEN_PATIENCE_MS
    while (this.#socket.readyState === WebSocket.CONNECTING && this.#closed === undefined && Date.now() < until) await this.#something(until)
    if (this.#socket.readyState !== WebSocket.OPEN) throw new Error('The connection to the concierge did not open.')
    this.#socket.send(helloText(backend.visitorToken('lb-02'), conversation))
    const first = await this.#next(OPEN_PATIENCE_MS)
    if (first.type !== 'ready') throw new Error(`The concierge answered the hello with "${first.type}", not "ready".`)
    return first
  }

  /** Moves the calendar changes that have arrived out of the queue, leaving every other event where it is. */
  #absorb(): void {
    const rest: ServerEvent[] = []
    for (const event of this.#events.splice(0)) {
      if (event.type === 'calendar') this.#calendar.push(event)
      else if (event.type !== 'calendar_reset') rest.push(event)
    }
    this.#events.push(...rest)
  }

  /**
   * Waits until the calendar changes that reached the conversation since its last reply include one the
   * test accepts, or the time is up. The changes are left in place for the next reply to be kept with.
   * Another visitor's connection and this one are two sockets, so the change may arrive a moment after
   * the other visitor's last reply does.
   */
  async sawChange(accepts: (change: CalendarEvent['changes'][number]) => boolean, patienceMs: number): Promise<boolean> {
    const until = Date.now() + patienceMs
    for (;;) {
      this.#absorb()
      if (this.#calendar.some(message => message.changes.some(accepts))) return true
      if (this.#closed !== undefined || Date.now() >= until) return false
      await this.#something(until)
    }
  }

  /** Says a message and waits for the reply; returns it with the calendar changes that came before it. */
  async say(text: string): Promise<{ reply: ReplyEvent, calendar: CalendarEvent[] }> {
    this.#socket.send(messageText(text))
    for (;;) {
      const event = await this.#next(ANSWER_PATIENCE_MS)
      if (event.type === 'calendar') this.#calendar.push(event)
      else if (event.type === 'reply') return { reply: event, calendar: this.#calendar.splice(0) }
      else if (event.type === 'error') throw new Error(`The concierge answered with the error "${event.code}".`)
    }
  }

  /** Closes the connection. The conversation, and any hold it has, stays on the server. */
  close(): void {
    this.#socket.close(1000)
  }
}

/** Adds days to a date given as `YYYY-MM-DD`. */
function addDays(date: string, days: number): string {
  const moved = new Date(`${date}T12:00:00Z`)
  moved.setUTCDate(moved.getUTCDate() + days)
  return moved.toISOString().slice(0, 10)
}

/** Writes a moment's time of day in Prague as `HH:MM`. */
function pragueClock(moment: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(moment))
}

/** Words a day counted from tomorrow, for a visitor's message. Only the days the concierge reads without a date are supported. */
function dayWords(day: number): string {
  if (day === 1) return 'tomorrow'
  if (day === 2) return 'the day after tomorrow'
  throw new Error(`The recorder can only ask for a slot tomorrow or the day after (day ${day} was asked for).`)
}

/** What another visitor says to hold or book a slot: ask for it, choose it, and confirm it when booking. */
function otherVisitorSays(event: SampleWorldEvent, title: string): string[] {
  const asks = `Hello! I'd like a ${title} for two ${dayWords(event.day)} at ${event.time}. I'm Alex Other, alex@example.test.`
  const chooses = 'Yes, that one.'
  return event.otherVisitor === 'books' ? [asks, chooses, 'Yes, please confirm it.'] : [asks, chooses]
}

/** Lets another visitor do what a sample says they do, and checks that the first visitor's calendar shows it. */
async function playOtherVisitor(backend: Backend, watcher: Visit, event: SampleWorldEvent, offerings: readonly Offering[], today: string): Promise<void> {
  const offering = offerings.find(item => item.key === event.offering)
  if (!offering) throw new Error(`The back end does not offer "${event.offering}", which the sample's other visitor asks for.`)
  const other = backend.another()
  const visit = new Visit(other)
  try {
    await visit.hello(other, null)
    for (const text of otherVisitorSays(event, offering.title.en)) await visit.say(text)
  }
  finally {
    visit.close()
  }
  const wanted = event.otherVisitor === 'books' ? 'booked' : 'held'
  const date = addDays(today, event.day)
  const seen = await watcher.sawChange(change => change.offering === event.offering && pragueDate(change.starts_at) === date && pragueClock(change.starts_at) === event.time && change.status === wanted && !change.mine, CHANGE_PATIENCE_MS)
  if (!seen) throw new Error(`The other visitor did not ${event.otherVisitor === 'books' ? 'book' : 'hold'} the ${event.offering} on ${date} at ${event.time}, so the sample would not show what it says. Nothing was recorded.`)
}

/** Keeps a JSON value as the body of an exchange. */
function json(value: unknown): NonNullable<Exchange['response']['body']> {
  return JSON.parse(JSON.stringify(value)) as NonNullable<Exchange['response']['body']>
}

/** Runs one of LB-02's samples and returns what the board asked and was told, and the run's ID. */
export async function runLb02Sample(backend: Backend, sampleId: string): Promise<RecordedRun> {
  const sample = LB02_SAMPLES.find(candidate => candidate.id === sampleId)
  if (!sample) throw new Error(`LB-02 has no sample called "${sampleId}". Its samples are: ${LB02_SAMPLES.map(item => item.id).join(', ')}.`)

  const offeringsAnswer = await backend.call('lb-02', 'GET', '/api/lb02/offerings')
  if (offeringsAnswer.status !== 200) throw new Error(`Reading what can be booked answered status ${offeringsAnswer.status}.`)
  const offerings = offeringsSchema.parse(offeringsAnswer.body)

  // The calendar the conversation opens on, read before it exists, so no slot is the visitor's own yet.
  const calendarAnswer = await backend.call('lb-02', 'GET', RECORDED_PATHS.calendar)
  if (calendarAnswer.status !== 200) throw new Error(`Reading the calendar answered status ${calendarAnswer.status}.`)
  const snapshot = calendarSchema.parse(calendarAnswer.body)
  const exchanges: Exchange[] = [{ request: { method: 'GET', path: RECORDED_PATHS.calendar }, response: { status: 200, body: json(snapshot) } }]

  const visit = new Visit(backend)
  try {
    const ready = await visit.hello(backend, null)
    exchanges.push({ request: { method: 'POST', path: RECORDED_PATHS.hello, body: { conversation: null } }, response: { status: 200, body: json(ready) } })

    const today = pragueDate(snapshot.as_of)
    for (const [index, turn] of sample.turns.entries()) {
      for (const event of sample.world.filter(item => item.beforeTurn === index + 1)) await playOtherVisitor(backend, visit, event, offerings, today)
      if (turn.waitMinutes > 0) await backend.waitMinutes(turn.waitMinutes)
      const answer = await visit.say(turn.say)
      exchanges.push({
        request: { method: 'POST', path: RECORDED_PATHS.message, body: { text: turn.say, waitMinutes: turn.waitMinutes } },
        response: { status: 200, body: json({ reply: answer.reply, calendar: answer.calendar }) },
      })
    }

    const path = `${RECORDED_PATHS.conversationPrefix}${ready.conversation}`
    const detailAnswer = await backend.call('lb-02', 'GET', path)
    if (detailAnswer.status !== 200) throw new Error(`Reading the conversation answered status ${detailAnswer.status}.`)
    const detail = conversationSchema.parse(detailAnswer.body)
    exchanges.push({ request: { method: 'GET', path }, response: { status: 200, body: json(detail) } })
    return { language: sample.language, exchanges, runId: detail.run_id, rootless: true }
  }
  finally {
    visit.close()
  }
}
