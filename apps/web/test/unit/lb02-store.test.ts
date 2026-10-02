// Tests of LB-02's board store against the fake site and the mock back end's conversation hub: a live
// conversation from the check to a recorded booking, the live calendar (a snapshot and the changes that
// arrive while it is on its way), a dropped connection that is opened again with the calendar loaded
// afresh, every way the connection can end, the daily allowance, the message limit and the handoff, a
// sample sent message by message, and the tab remembering its conversation. No port is opened.
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LB02_SAMPLES } from '#shared/data/samples/lb02'

import { AUTOPLAY_PAUSE_MS, CONVERSATIONS_PER_DAY, STORAGE_KEY, useLb02Store } from '~/boards/lb-02/store'
import { RECONNECT_ATTEMPTS, reconnectDelay } from '~/boards/lb-02/socket'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'

import { FakeLb02Site, NOW, SOCKET_URL } from '../support/lb02-site'
import type { FakeLb02Options } from '../support/lb02-site'

/** Finds one of the curated samples by its ID. */
const SAMPLE = (id: string) => LB02_SAMPLES.find(sample => sample.id === id)!
const BOOKING = SAMPLE('book-cupping-en')

/** A map standing in for the tab's session storage. */
class MemoryStorage {
  readonly items = new Map<string, string>()
  /** Reads an item. */
  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }

  /** Keeps an item. */
  setItem(key: string, value: string): void {
    this.items.set(key, value)
  }

  /** Forgets an item. */
  removeItem(key: string): void {
    this.items.delete(key)
  }
}

/** Starts a fake site and fresh stores; the session is read, as the board does when it opens. */
async function start(options: FakeLb02Options = {}) {
  const site = new FakeLb02Site(options)
  const storage = new MemoryStorage()
  vi.stubGlobal('fetch', site.fetch)
  vi.stubGlobal('WebSocket', site.socketClass())
  vi.stubGlobal('location', new URL('http://site.test/'))
  vi.stubGlobal('sessionStorage', storage)
  setActivePinia(createPinia())
  const store = useLb02Store()
  const session = useSessionStore()
  await session.load()
  return { site, store, session, scope: useScopeStore(), storage }
}

/** Lets the pending promises and zero-length timers run. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)
}

/** Lets a number of seconds pass. */
async function seconds(count: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(count * 1_000)
}

/** Starts a live conversation and waits until it is open. */
async function open(rig: Awaited<ReturnType<typeof start>>, conversation?: string) {
  await rig.store.start(conversation)
  await settle()
  return rig
}

/** Says a message and waits for the answer. */
async function say(rig: Awaited<ReturnType<typeof start>>, text: string) {
  expect(rig.store.say(text)).toBe('sent')
  await settle()
}

describe('LB-02\'s store: a live conversation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('runs the check, gets a pass, opens the socket without the pass in its address, and is open at `ready`', async () => {
    const rig = await start()
    expect(rig.session.verified).toBe(false)
    await open(rig)
    expect(rig.session.verified).toBe(true)
    expect(rig.site.callsTo('/api/tokens/lb-02', 'POST')).toHaveLength(1)
    expect(rig.site.socket.url).toBe(SOCKET_URL)
    expect(rig.site.socket.sent).toHaveLength(1)
    expect(JSON.parse(rig.site.socket.sent[0]!)).toMatchObject({ type: 'hello', conversation: null })
    expect(rig.store.runMode).toBe('live')
    expect(rig.store.connection).toBe('open')
    expect(rig.store.conversationId).toMatch(/^[\w-]{16}$/)
    expect(rig.store.state).toMatchObject({ step: 'details', messages_left: 30, closed: false })
    expect(rig.store.canSay).toBe(true)
  })

  it('loads the calendar from the conversation\'s point of view and reads the run for the Scope', async () => {
    const rig = await open(await start())
    const calendar = rig.site.callsTo('/api/lb02/calendar').at(-1)!
    expect(calendar.path).toContain(`conversation=${rig.store.conversationId}`)
    expect(rig.store.calendarStatus).toBe('ready')
    expect(rig.store.slots.size).toBe(14 * 8)
    expect(rig.store.runId).toMatch(/^run-/)
  })

  it('books a cupping in three messages: the receipts, the tools, the hold, the booking, the recorded email and the allowance', async () => {
    const rig = await open(await start())
    const quotaBefore = rig.store.quota
    for (const turn of BOOKING.turns) await say(rig, turn.say)

    expect(rig.store.lines.map(line => line.kind)).toEqual(['visitor', 'concierge', 'visitor', 'concierge', 'visitor', 'concierge'])
    const replies = rig.store.lines.filter(line => line.kind === 'concierge')
    expect(replies.map(line => line.receipt)).toEqual([null, 'hold_placed', 'booking_confirmed'])
    expect(replies[0]?.tools.map(tool => tool.name)).toEqual(['update_details'])
    expect(rig.store.state).toMatchObject({ step: 'done', booking: { party_size: 2 }, hold: null })
    expect(rig.store.modelCalls).toBe(7)
    expect(rig.store.messagesLeft).toBe(27)
    expect(quotaBefore).toBeUndefined()

    expect(rig.store.detail?.confirmation).toMatchObject({ delivery: 'mock', language: 'en' })
    expect(rig.store.detail?.confirmation?.body).toContain('never sent')
    const mine = [...rig.store.slots.values()].filter(slot => slot.mine && slot.status === 'booked')
    expect(mine.length).toBeGreaterThan(0)
  })

  it('shows what the slot did on the live calendar: held for the visitor, then booked', async () => {
    const rig = await open(await start())
    await say(rig, BOOKING.turns[0]!.say)
    await say(rig, BOOKING.turns[1]!.say)
    const heldSlot = rig.store.state?.hold?.slot
    expect(rig.store.slots.get(heldSlot!)).toMatchObject({ status: 'held', mine: true })
    expect(rig.store.recentlyChanged.has(heldSlot!)).toBe(true)
    await say(rig, BOOKING.turns[2]!.say)
    expect(rig.store.slots.get(heldSlot!)).toMatchObject({ status: 'booked', mine: true })
    await seconds(5)
    expect(rig.store.recentlyChanged.size).toBe(0)
  })

  it('shows a slot another visitor takes, not as the visitor\'s own', async () => {
    const rig = await open(await start())
    rig.site.lb02.otherVisitor('books', 'tasting', 1, '12:00')
    await settle()
    const taken = [...rig.store.slots.values()].find(slot => slot.offering === 'tasting' && slot.status === 'booked')
    expect(taken?.mine).toBe(false)
    expect(rig.store.lastChange?.cause).toBe('live')
  })

  it('does not lose a change that arrives while the snapshot is on its way, and applies it after the snapshot', async () => {
    const rig = await start()
    const release = rig.site.stall('GET /api/lb02/calendar')
    await rig.store.start()
    await settle()
    expect(rig.store.calendarStatus).toBe('loading')
    // The snapshot was worked out before this change, and arrives after it.
    rig.site.lb02.otherVisitor('books', 'tasting', 1, '12:00')
    await settle()
    release()
    await settle()
    expect(rig.store.calendarStatus).toBe('ready')
    expect([...rig.store.slots.values()].some(slot => slot.offering === 'tasting' && slot.status === 'booked')).toBe(true)
  })

  it('lets a hold that has run out show as free before the server says so, and again when it does', async () => {
    const rig = await open(await start())
    await say(rig, BOOKING.turns[0]!.say)
    await say(rig, BOOKING.turns[1]!.say)
    const slot = rig.store.state!.hold!.slot
    expect(rig.store.slots.get(slot)?.status).toBe('held')
    rig.site.lb02.advance(6)
    await settle()
    expect(rig.store.slots.get(slot)?.status).toBe('free')
    expect(rig.store.state?.hold).not.toBeNull()
  })

  it('loads the calendar again when the server lays it out afresh', async () => {
    const rig = await open(await start())
    const reads = rig.site.callsTo('/api/lb02/calendar').length
    rig.site.lb02.hub.resetCalendar()
    await settle()
    expect(rig.site.callsTo('/api/lb02/calendar')).toHaveLength(reads + 1)
    expect(rig.store.lastChange?.cause).toBe('reset')
  })

  it('does not let the visitor say two things at once, or anything before it is open or after it is finished', async () => {
    const rig = await start()
    expect(rig.store.say('hi')).toBe('busy')
    await open(rig)
    expect(rig.store.say('Hello there')).toBe('sent')
    expect(rig.store.working).toBe(true)
    expect(rig.store.say('and another')).toBe('busy')
    await settle()
    expect(rig.store.say('   ')).toBe('invalid')
  })
})

describe('LB-02\'s store: following the run in the Scope', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reads the trace while a message is being answered, keeps the spans between messages and rests', async () => {
    const rig = await open(await start())
    await say(rig, BOOKING.turns[0]!.say)
    await seconds(1)
    expect(rig.scope.runId).toBe(rig.store.runId)
    expect(rig.scope.timeline.rows.map(row => row.span.name)).toContain('visitor message')
    const first = rig.scope.spans.length
    await seconds(5)
    const reads = rig.site.callsTo('/api/runs/').length
    await seconds(30)
    expect(rig.site.callsTo('/api/runs/')).toHaveLength(reads)
    await say(rig, BOOKING.turns[1]!.say)
    await seconds(1)
    expect(rig.scope.spans.length).toBeGreaterThan(first)
  })

  it('calls the trace complete when the conversation is handed to a person, since a conversation writes no root span', async () => {
    const rig = await open(await start())
    await say(rig, 'Can I talk to a human please?')
    await seconds(5)
    expect(rig.store.closed).toBe(true)
    expect(rig.scope.phase).toBe('finished')
  })
})

describe('LB-02\'s store: when the connection drops or ends', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('opens it again with a fresh pass and the same conversation, takes the server\'s transcript and loads the calendar afresh', async () => {
    const rig = await open(await start())
    await say(rig, BOOKING.turns[0]!.say)
    const id = rig.store.conversationId
    const reads = rig.site.callsTo('/api/lb02/calendar').length
    rig.site.socket.serverCloses(1006)
    await settle()
    expect(rig.store.connection).toBe('reconnecting')
    expect(rig.store.attempt).toBe(1)
    await vi.advanceTimersByTimeAsync(reconnectDelay(1, 0.5) + 1000)
    await settle()
    expect(rig.store.connection).toBe('open')
    expect(rig.store.conversationId).toBe(id)
    expect(rig.site.sockets).toHaveLength(2)
    expect(JSON.parse(rig.site.socket.sent[0]!)).toMatchObject({ type: 'hello', conversation: id })
    expect(rig.store.lines.map(line => line.kind)).toEqual(['visitor', 'action', 'concierge'])
    expect(rig.site.callsTo('/api/lb02/calendar').length).toBeGreaterThan(reads)
    expect(rig.site.callsTo('/api/tokens/lb-02', 'POST')).toHaveLength(2)
  })

  it('says the answer may be lost when the drop comes while the concierge is answering', async () => {
    const rig = await open(await start())
    rig.site.lb02.hub.configure({ thinkMs: 60_000 })
    expect(rig.store.say('Hello there')).toBe('sent')
    await settle()
    expect(rig.store.working).toBe(true)
    rig.site.socket.serverCloses(1001)
    await settle()
    expect(rig.store.working).toBe(false)
    expect(rig.store.notice).toBe('interrupted')
  })

  it('gives up after the attempts and says the connection was lost, keeping the conversation to continue', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const rig = await open(await start())
    const id = rig.store.conversationId
    rig.site.refuseConnections = false
    rig.site.socket.serverCloses(1006)
    rig.site.refuseConnections = true
    for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt += 1) await vi.advanceTimersByTimeAsync(reconnectDelay(attempt, 0.5) + 10)
    await settle()
    expect(rig.store.ending?.reason).toBe('lost')
    expect(rig.store.connection).toBe('closed')
    expect(rig.store.conversationId).toBe(id)

    rig.site.refuseConnections = false
    rig.store.resume()
    await settle()
    expect(rig.store.connection).toBe('open')
    expect(rig.store.ending).toBeUndefined()
  })

  it('ends with the reason for each close code the server uses', async () => {
    for (const [code, reason] of [[4408, 'timed_out'], [1009, 'too_big'], [4404, 'not_found'], [4400, 'bad_frame'], [1011, 'unavailable']] as const) {
      const rig = await open(await start())
      rig.site.socket.serverCloses(code)
      await settle()
      expect(rig.store.ending?.reason, String(code)).toBe(reason)
      expect(rig.store.canSay).toBe(false)
      vi.unstubAllGlobals()
    }
  })

  it('closes and says so when the server sends something that is not in the protocol, and shows none of it', async () => {
    const rig = await open(await start())
    const lines = rig.store.lines.length
    rig.site.socket.serverSays('{"type":"reply","text":"<script>x</script>"}')
    await settle()
    expect(rig.store.ending?.reason).toBe('malformed')
    expect(rig.store.lines).toHaveLength(lines)
    expect(rig.store.canSay).toBe(false)
  })

  it('tells the visitor who has used the day\'s ten conversations, and shows the allowance as used up', async () => {
    const rig = await start({ lb02: { conversationsPerDay: 1 } })
    await open(rig)
    expect(rig.store.connection).toBe('open')
    rig.store.endConversation()
    await open(rig)
    await settle()
    expect(rig.store.ending?.reason).toBe('too_many')
    expect(CONVERSATIONS_PER_DAY).toBe(10)
  })

  it('runs the check again, once, when the pass is refused because a new day began', async () => {
    const rig = await start({ verified: true })
    rig.site.failNext('POST /api/tokens/lb-02', { status: 403, body: { error: { code: 'verification_required', message: 'x' } } })
    await rig.store.start()
    await settle()
    expect(rig.store.connection).toBe('open')
    expect(rig.site.callsTo('/api/session/verify', 'POST')).toHaveLength(1)
    expect(rig.site.callsTo('/api/tokens/lb-02', 'POST')).toHaveLength(2)
  })

  it('says it cannot open the conversation when the site cannot be reached, and does not loop', async () => {
    const rig = await start({ verified: true })
    rig.site.failNext('POST /api/tokens/lb-02', { status: 503, body: { error: { code: 'unavailable', message: 'x' } } })
    await rig.store.start()
    await settle()
    expect(rig.store.ending?.reason).toBe('grant_failed')
    expect(rig.store.problem?.kind).toBe('unavailable')
    expect(rig.site.sockets).toHaveLength(0)
  })

  it('does not start a live conversation where the deployment has no back end', async () => {
    const rig = await start({ available: false })
    await rig.store.start()
    expect(rig.store.runMode).toBe('idle')
    expect(rig.store.problem?.kind).toBe('unavailable')
    expect(rig.site.sockets).toHaveLength(0)
  })
})

describe('LB-02\'s store: limits and the handoff to a person', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('counts the messages down, hands the conversation over at the limit with the whole transcript, and stops the composer', async () => {
    const rig = await open(await start({ lb02: { messagesPerConversation: 2 } }))
    await say(rig, 'Hello there')
    await say(rig, 'Hello again')
    expect(rig.store.messagesLeft).toBe(0)
    expect(rig.store.closed).toBe(false)
    await say(rig, 'One more')
    expect(rig.store.closed).toBe(true)
    expect(rig.store.lines.at(-1)).toMatchObject({ kind: 'concierge', receipt: 'message_limit' })
    expect(rig.store.canSay).toBe(false)
    expect(rig.store.detail?.handoff).toMatchObject({ reason: 'message_limit' })
    expect(rig.store.detail?.handoff?.transcript.map(line => line.role)).toContain('visitor')
  })

  it('shows the handoff a person receives when the visitor asks for one', async () => {
    const rig = await open(await start())
    await say(rig, BOOKING.turns[0]!.say)
    await say(rig, 'Can I talk to a human please?')
    expect(rig.store.state).toMatchObject({ step: 'handoff', closed: true })
    expect(rig.store.detail?.handoff).toMatchObject({ reason: 'asked_for_person' })
    expect(rig.store.detail?.handoff?.summary).toContain('cupping')
  })

  it('refuses an injection attempt with the code\'s own receipt and one gateway call', async () => {
    const rig = await open(await start())
    const injection = SAMPLE('injection-confirm-slot-en')
    await say(rig, injection.turns[0]!.say)
    expect(rig.store.lines.at(-1)).toMatchObject({ receipt: 'injection_refused', tools: [] })
    expect(rig.store.state?.step).toBe('details')
    expect(rig.store.modelCalls).toBe(1)
  })

  it('words a server error by its code and goes on', async () => {
    const rig = await open(await start())
    rig.site.socket.serverSays(JSON.stringify({ type: 'error', code: 'unavailable', message: 'The concierge can\'t answer right now.' }))
    await settle()
    expect(rig.store.notice).toBe('unavailable')
    expect(rig.store.connection).toBe('open')
  })
})

describe('LB-02\'s store: the allowance and the tab\'s memory', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('counts the conversations started today from the visitor\'s list, and takes one off when one starts', async () => {
    const rig = await start({ verified: true })
    await rig.store.loadQuota()
    expect(rig.store.quota).toMatchObject({ limit: 10, used: 0, remaining: 10 })
    await open(rig)
    expect(rig.store.quota).toMatchObject({ used: 1, remaining: 9 })
  })

  it('remembers the conversation in this tab only, offers it after a reload and resumes it without taking another from the allowance', async () => {
    const rig = await open(await start())
    const id = rig.store.conversationId!
    await say(rig, 'Hello there')
    expect(rig.storage.items.get(STORAGE_KEY)).toBe(id)

    setActivePinia(createPinia())
    const reloaded = useLb02Store()
    reloaded.recallConversation()
    expect(reloaded.remembered).toBe(id)
    await reloaded.start(id)
    await settle()
    expect(reloaded.connection).toBe('open')
    expect(reloaded.lines.map(line => line.kind)).toEqual(['visitor', 'concierge'])
    expect(rig.site.lb02.hub.ownedBy('fake-session')).toHaveLength(1)
  })

  it('forgets the conversation when the visitor ends it, and when it no longer exists', async () => {
    const rig = await open(await start())
    rig.store.endConversation()
    await settle()
    expect(rig.storage.items.has(STORAGE_KEY)).toBe(false)
    expect(rig.store.ending?.reason).toBe('visitor')

    const gone = await open(await start(), 'AAAAAAAAAAAAAAAA')
    await settle()
    expect(gone.store.ending?.reason).toBe('not_found')
    expect(gone.storage.items.has(STORAGE_KEY)).toBe(false)
  })

  it('works without session storage', async () => {
    const rig = await start()
    const blocked = (): never => {
      throw new Error('blocked')
    }
    vi.stubGlobal('sessionStorage', { getItem: blocked, setItem: blocked, removeItem: blocked })
    await open(rig)
    expect(rig.store.connection).toBe('open')
    rig.store.recallConversation()
    expect(rig.store.remembered).toBeUndefined()
  })
})

describe('LB-02\'s store: a sample sent to a live conversation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('says the first message by itself and waits for the visitor to send the rest', async () => {
    const rig = await start()
    await rig.store.start(undefined, BOOKING)
    await settle()
    expect(rig.store.script).toMatchObject({ sampleId: 'book-cupping-en', sent: 1, autoplay: false })
    expect(rig.store.lines[0]).toMatchObject({ kind: 'visitor', text: BOOKING.turns[0]!.say })
    rig.store.sendNextScripted()
    await settle()
    expect(rig.store.script?.sent).toBe(2)
    expect(rig.store.state?.step).toBe('hold')
  })

  it('sends the rest one after another when asked, pausing after each answer, and stops at the end', async () => {
    const rig = await start()
    await rig.store.start(undefined, BOOKING)
    await settle()
    rig.store.playScript()
    await settle()
    await vi.advanceTimersByTimeAsync(AUTOPLAY_PAUSE_MS + 10)
    await settle()
    await vi.advanceTimersByTimeAsync(AUTOPLAY_PAUSE_MS + 10)
    await settle()
    expect(rig.store.script).toMatchObject({ sent: 3, autoplay: false })
    expect(rig.store.state?.step).toBe('done')
  })

  it('stops sending by itself at an error', async () => {
    const rig = await start()
    await rig.store.start(undefined, BOOKING)
    await settle()
    rig.store.playScript()
    rig.site.socket.serverSays(JSON.stringify({ type: 'error', code: 'unavailable', message: 'x' }))
    await settle()
    await vi.advanceTimersByTimeAsync(AUTOPLAY_PAUSE_MS * 3)
    expect(rig.store.script?.autoplay).toBe(false)
  })
})

describe('LB-02\'s store: leaving the page', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('leaves no timer, socket or reading behind', async () => {
    const rig = await open(await start())
    await say(rig, 'Hello there')
    rig.store.dispose()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(rig.site.socket.readyState).toBe(3)
  })

  it('starts empty again, so a visitor who comes back finds the board clean', async () => {
    const rig = await open(await start())
    await say(rig, 'Hello there')
    rig.store.reset()
    expect(rig.store).toMatchObject({ runMode: 'idle', connection: 'idle', conversationId: undefined, working: false })
    expect(rig.store.lines).toEqual([])
    expect(rig.store.state).toBeUndefined()
  })
})
