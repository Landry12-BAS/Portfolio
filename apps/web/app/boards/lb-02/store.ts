// LB-02's board state: the conversation with the concierge (live over a WebSocket, or replayed from a
// recording), the live calendar, what can be booked, the booking and the recorded confirmation, the
// handoff to a person, the visitor's allowance of conversations, and the Scope's follow of the run.
//
// The conversation travels over the WebSocket (socket.ts), which gives the board its own events; the
// rest comes from the site's API through the typed client, every answer checked with its schema. The
// calendar is a snapshot plus the changes that follow it: the board opens the socket first, asks for
// the snapshot, and applies the changes that arrived while it was on its way, so no change is lost,
// and it asks for the snapshot again whenever the connection comes back. Nothing here logs or stores
// what was said; the only thing kept in the browser is the conversation's ID in this tab's session
// storage, so a reload can offer to pick the conversation up again.
import type { Exchange, Recording } from '@lb/contracts'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'

import { socketGrantSchema } from '#shared/schema/session'
import type { ConversationSample } from '#shared/data/samples/lb02-types'

import { apiClients, callApi, postJson } from '~/board-kit/api'
import type { ApiProblem } from '~/board-kit/problem'
import { badAnswerProblem, cookieProblem, isApiProblem, unavailableProblem, verificationProblem } from '~/board-kit/problem'
import { exhausted, quotaFromRuns } from '~/board-kit/quota'
import type { Quota } from '~/board-kit/quota'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'

import { applyChanges, changedSlots, clockOffset, slotsFromSnapshot } from './calendar'
import type { SlotMap } from './calendar'
import { LineNumbers, linesFromTranscript } from './chat'
import type { ChatLine } from './chat'
import { readRecordedExchange } from './recorded'
import { calendarSchema, conversationListSchema, conversationSchema, offeringsSchema } from './schemas'
import type { CalendarSlot, ConversationDetail, Offering } from './schemas'
import { ConversationSocket } from './socket'
import type { ConnectionStatus, End, Grant, SendResult } from './socket'
import { MESSAGES_PER_CONVERSATION } from './wire'
import type { CalendarEvent, ConversationState, ErrorCode, ReadyEvent, ReplyEvent, ServerEvent } from './wire'

/** How many conversations a visitor may start in a day: the back end's own limit (services/django-systems/lb02/limits.py). */
export const CONVERSATIONS_PER_DAY = 10
/** How long the Scope waits for the first spans of a conversation: they are written when the first message has been answered. */
export const TRACE_GRACE_MS = 30_000
/** How long after an answer the Scope keeps reading before it rests until the next message. */
export const TRACE_LAST_LOOK_MS = 3_000
/** The pause between two messages of a sample that is sent one after another. */
export const AUTOPLAY_PAUSE_MS = 900
/** How long a slot that just changed stays marked on the calendar. */
export const HIGHLIGHT_MS = 4_000
/** Where this tab remembers its conversation. */
export const STORAGE_KEY = 'lb02.conversation'

// The ID a conversation has: URL-safe characters, 16 to 24 of them (lb02/events.py).
const CONVERSATION_ID = /^[\w-]{16,24}$/

/** What is on the board: nothing, a live conversation, or a replay. */
export type RunMode = 'idle' | 'live' | 'replay'

/** A sample being sent to the live conversation, message by message. */
export interface Script {
  sampleId: string
  turns: ConversationSample['turns']
  // How many of the messages are sent.
  sent: number
  // Whether the rest follow one another by themselves.
  autoplay: boolean
}

/** What changed on the calendar last, for the live region that tells a screen reader: the slots, and why the calendar moved. */
export interface ChangeNote {
  slots: CalendarSlot[]
  // Counts up with every change, so the same text said twice is still announced twice.
  sequence: number
  cause: 'live' | 'reset' | 'reconnect'
}

/** What `say` did with a message: sent, refused because the conversation can't take one now, or not sent. */
export type SayResult = SendResult | 'busy'

/** What the page tells the visitor about a problem it can word itself, by the code of an error event or its own. */
export type NoticeKind = ErrorCode | 'interrupted' | 'not_open'

/** Opens a WebSocket the way the browser does. It is looked up when it is used, so a test can replace it. */
function browserSocket(url: string) {
  return new globalThis.WebSocket(url)
}

/** Reads the address of the socket the site's server named, and refuses anything that is not a WebSocket address without credentials. */
function socketAddress(text: string): string {
  let url: URL
  try {
    url = new URL(text)
  }
  catch {
    throw badAnswerProblem()
  }
  if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || url.username !== '' || url.password !== '') throw badAnswerProblem()
  return url.toString()
}

/** Asks the site for a pass for the socket: five minutes, for LB-02 only, and where to open it. */
async function fetchGrant(): Promise<Grant> {
  const grant = await postJson('/api/tokens/lb-02', undefined, socketGrantSchema)
  return { url: socketAddress(grant.socketUrl), token: grant.token }
}

/** Reads the conversation ID this tab remembered, if the browser lets it and what it holds is an ID. */
function rememberedConversation(): string | undefined {
  try {
    const stored = globalThis.sessionStorage.getItem(STORAGE_KEY)
    return stored !== null && CONVERSATION_ID.test(stored) ? stored : undefined
  }
  catch {
    return undefined
  }
}

/** Remembers a conversation's ID in this tab, or forgets it when none is given. Storage can be off, and then the offer to continue is simply not made. */
function rememberConversation(id: string | undefined): void {
  try {
    if (id === undefined) globalThis.sessionStorage.removeItem(STORAGE_KEY)
    else globalThis.sessionStorage.setItem(STORAGE_KEY, id)
  }
  catch {
    // Without storage the conversation is not remembered, and the page works the same.
  }
}

/** Takes the part of an event that says where the conversation stands. */
function stateOf(event: ReadyEvent | ReplyEvent): ConversationState {
  return { step: event.step, language: event.language, messages_left: event.messages_left, closed: event.closed, options: event.options, hold: event.hold, booking: event.booking }
}

/** LB-02's board. */
export const useLb02Store = defineStore('lb02', () => {
  const session = useSessionStore()
  const scope = useScopeStore()
  const replay = useReplayStore()

  // The conversation.
  const runMode = ref<RunMode>('idle')
  const connection = ref<ConnectionStatus>('idle')
  const attempt = ref(0)
  const ending = shallowRef<End>()
  const problem = shallowRef<ApiProblem>()
  const notice = ref<NoticeKind>()
  const conversationId = ref<string>()
  const lines = shallowRef<readonly ChatLine[]>([])
  const working = ref(false)
  const state = shallowRef<ConversationState>()
  const modelCalls = ref(0)
  const detail = shallowRef<ConversationDetail>()
  const detailStatus = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const unsent = ref<string>()
  const script = shallowRef<Script>()
  const remembered = ref<string>()

  // The calendar and what can be booked.
  const slots = shallowRef<SlotMap>(new Map())
  const serverOffsetMs = ref(0)
  const calendarStatus = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const recentlyChanged = shallowRef<ReadonlySet<number>>(new Set())
  const lastChange = shallowRef<ChangeNote>()
  const offerings = shallowRef<readonly Offering[]>([])
  const quota = shallowRef<Quota>()
  // When the replay's calendar is frozen: a recorded hold never runs out on a page that is looked at later.
  const frozenAt = ref<number>()

  const numbers = new LineNumbers()
  let socket: ConversationSocket | undefined
  // Which run is current: starting another makes every late answer of an older one stop touching the board.
  let generation = 0
  // The calendar changes that arrive while a snapshot is on its way, and which snapshot read is current.
  let buffered: CalendarEvent[] | undefined
  let calendarReading = 0
  let sequence = 0
  let verificationRetried = false
  let highlightTimer: ReturnType<typeof setTimeout> | undefined
  let traceRestTimer: ReturnType<typeof setTimeout> | undefined
  let autoplayTimer: ReturnType<typeof setTimeout> | undefined

  const open = computed(() => connection.value === 'open')
  const messagesLeft = computed(() => state.value?.messages_left ?? MESSAGES_PER_CONVERSATION)
  const closed = computed(() => state.value?.closed === true)
  const canSay = computed(() => runMode.value === 'live' && open.value && !working.value && !closed.value)
  const runId = computed(() => detail.value?.run_id)

  /** The server's time now, by the page's clock and the offset the last snapshot showed. */
  function serverNow(): number {
    return frozenAt.value ?? Date.now() + serverOffsetMs.value
  }

  // What can be booked.

  /** Reads what can be booked. A failure leaves the offering names as their keys, which is better than a blank board. */
  async function loadOfferings(): Promise<void> {
    try {
      offerings.value = await callApi(apiClients().django.GET('/api/lb02/offerings'), offeringsSchema)
    }
    catch {
      // The calendar and the chat do not depend on the descriptions.
    }
  }

  /** Counts the conversations the visitor has started today from their list, against the daily limit. */
  async function loadQuota(): Promise<void> {
    const resetsAt = session.state?.resetsAt
    if (resetsAt === undefined) return
    try {
      const list = await callApi(apiClients().django.GET('/api/lb02/conversations'), conversationListSchema)
      quota.value = quotaFromRuns(list.map(item => item.created_at), CONVERSATIONS_PER_DAY, resetsAt)
    }
    catch {
      // Without a count the panel says it is counting, and a refusal from the back end still stops a conversation.
    }
  }

  // The calendar.

  /** Marks the slots that just changed for a few seconds, and tells the live region what changed. */
  function noteChange(changed: CalendarSlot[], cause: ChangeNote['cause']): void {
    sequence += 1
    lastChange.value = { slots: changed, sequence, cause }
    recentlyChanged.value = new Set(changed.map(slot => slot.id))
    if (highlightTimer !== undefined) clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => {
      recentlyChanged.value = new Set()
    }, HIGHLIGHT_MS)
  }

  /** Applies the changes of a `calendar` event to the slots. */
  function applyCalendarEvent(event: CalendarEvent): void {
    const before = slots.value
    slots.value = applyChanges(before, event.changes)
    const changed = changedSlots(before, slots.value)
    if (changed.length > 0) noteChange(changed, 'live')
  }

  /**
   * Reads the snapshot of the calendar and combines it with the changes that arrived while it was on
   * its way. The snapshot is read from the conversation's point of view, so its own slot is marked.
   * A failed read leaves the slots as they were. Called when a connection opens and whenever the
   * server says it laid the calendar out afresh.
   */
  async function loadCalendar(reason: 'open' | 'reset' | 'reconnect' = 'open'): Promise<void> {
    calendarReading += 1
    const reading = calendarReading
    buffered = []
    calendarStatus.value = 'loading'
    try {
      const query = conversationId.value === undefined ? {} : { conversation: conversationId.value }
      const snapshot = await callApi(apiClients().django.GET('/api/lb02/calendar', { params: { query } }), calendarSchema)
      if (reading !== calendarReading) return
      serverOffsetMs.value = clockOffset(snapshot, Date.now())
      let next = slotsFromSnapshot(snapshot)
      for (const event of buffered) next = applyChanges(next, event.changes)
      const before = slots.value
      slots.value = next
      calendarStatus.value = 'ready'
      if (reason !== 'open') noteChange(changedSlots(before, next), reason)
    }
    catch {
      if (reading === calendarReading) calendarStatus.value = 'failed'
    }
    finally {
      if (reading === calendarReading) buffered = undefined
    }
  }

  // The conversation's full record and the Scope.

  /** Reads the conversation in full: its run (for the Scope), the recorded confirmation and the handoff. */
  async function loadDetail(): Promise<void> {
    const id = conversationId.value
    if (id === undefined || runMode.value !== 'live') return
    const reading = generation
    detailStatus.value = 'loading'
    try {
      const full = await callApi(apiClients().django.GET('/api/lb02/conversations/{conversation_id}', { params: { path: { conversation_id: id } } }), conversationSchema)
      if (reading !== generation) return
      detail.value = full
      modelCalls.value = full.model_calls
      detailStatus.value = 'ready'
    }
    catch {
      if (reading === generation) detailStatus.value = 'failed'
    }
  }

  /** Follows the conversation's trace while a message is being answered. */
  async function followTrace(): Promise<void> {
    if (runMode.value !== 'live') return
    if (traceRestTimer !== undefined) clearTimeout(traceRestTimer)
    traceRestTimer = undefined
    if (runId.value === undefined) await loadDetail()
    const id = runId.value
    if (id !== undefined) scope.follow(id, { keepSpans: true, notFoundGraceMs: TRACE_GRACE_MS })
  }

  /** Lets the Scope read a little longer after an answer, so it sees the answer's last spans, and then rest. */
  function restTraceSoon(): void {
    if (traceRestTimer !== undefined) clearTimeout(traceRestTimer)
    traceRestTimer = setTimeout(() => {
      traceRestTimer = undefined
      if (closed.value) scope.finish()
      else scope.stop()
    }, TRACE_LAST_LOOK_MS)
  }

  // The events of a conversation.

  /** A conversation opened or was picked up again: its transcript replaces what the page held, since the server's is the record. */
  function onReady(event: ReadyEvent, live: boolean): void {
    conversationId.value = event.conversation
    state.value = stateOf(event)
    lines.value = linesFromTranscript(event.transcript, numbers)
    working.value = false
    notice.value = undefined
    ending.value = undefined
    problem.value = undefined
    if (!live) return
    rememberConversation(event.conversation)
    remembered.value = undefined
    void loadCalendar(event.resumed ? 'reconnect' : 'open')
    void loadDetail()
    if (!event.resumed && quota.value) quota.value = { ...quota.value, used: quota.value.used + 1, remaining: Math.max(quota.value.remaining - 1, 0) }
    // A sample run live says its first message by itself; the rest wait for the visitor, or for "send them all".
    if (!event.resumed && script.value?.sent === 0) sendNextScripted()
  }

  /** The concierge answered: its words, the tools it called, and where the booking stands now. */
  function onReply(event: ReplyEvent, live: boolean): void {
    lines.value = [...lines.value, { id: numbers.next(), kind: 'concierge', text: event.text, receipt: event.receipt, tools: event.tools }]
    state.value = stateOf(event)
    modelCalls.value = event.model_calls
    working.value = false
    if (!live) return
    restTraceSoon()
    if (event.closed || event.step === 'done' || event.step === 'handoff') void loadDetail()
    continueScript()
  }

  /** Something the server says can't be done: the page words it by its code. */
  function onProblem(code: ErrorCode): void {
    notice.value = code
    working.value = false
    stopScript()
  }

  /** Takes one event from the socket. */
  function onEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'ready':
        onReady(event, true)
        break
      case 'working':
        working.value = true
        void followTrace()
        break
      case 'reply':
        onReply(event, true)
        break
      case 'calendar':
        if (buffered !== undefined) buffered.push(event)
        else applyCalendarEvent(event)
        break
      case 'calendar_reset':
        void loadCalendar('reset')
        break
      case 'error':
        onProblem(event.code)
        break
    }
  }

  /** The connection's status changed. A drop while the concierge was answering is said, since its answer is lost. */
  function onStatus(status: ConnectionStatus, attempts: number): void {
    if (status === 'reconnecting' && working.value) {
      notice.value = 'interrupted'
      working.value = false
    }
    connection.value = status
    attempt.value = attempts
  }

  /** The connection ended for good: what the board says depends on the reason, and on whether the conversation can be picked up. */
  function onEnded(end: End): void {
    ending.value = end
    working.value = false
    stopScript()
    if (traceRestTimer !== undefined) clearTimeout(traceRestTimer)
    if (end.reason === 'grant_failed' && isApiProblem(end.cause)) {
      problem.value = end.cause
      // A new day began and the check is needed again: run it and open the socket once more.
      if (end.cause.kind === 'verification' && !verificationRetried) {
        verificationRetried = true
        void retryAfterCheck()
        return
      }
    }
    if (end.reason === 'too_many' && quota.value) quota.value = exhausted(quota.value)
    if (end.reason === 'visitor' || end.reason === 'not_found' || end.reason === 'bad_frame') rememberConversation(undefined)
    if (conversationId.value !== undefined && closed.value) scope.finish()
    else scope.stop()
  }

  /** Runs the check again after the server said it is needed (a new day began), and opens the conversation once more. */
  async function retryAfterCheck(): Promise<void> {
    const reading = generation
    session.forgetVerification()
    if (!(await session.ensureVerified())) {
      if (reading !== generation) return
      problem.value = session.available ? (session.problem ?? verificationProblem()) : unavailableProblem()
      return
    }
    if (reading !== generation) return
    ending.value = undefined
    problem.value = undefined
    socket?.open(conversationId.value ?? null)
  }

  // Starting, talking and ending.

  /** Makes the client for a new conversation, with the events and the status going to the board. */
  function newSocket(): ConversationSocket {
    return new ConversationSocket(
      { grant: fetchGrant, connect: browserSocket, random: Math.random },
      { status: onStatus, event: onEvent, ended: onEnded },
    )
  }

  /** Stops what the board is doing for the conversation: its socket, its timers, the Scope's reading and a replay. */
  function stopRun(): void {
    generation += 1
    socket?.dispose()
    socket = undefined
    replay.stop()
    scope.stop()
    for (const timer of [highlightTimer, traceRestTimer, autoplayTimer]) {
      if (timer !== undefined) clearTimeout(timer)
    }
    highlightTimer = undefined
    traceRestTimer = undefined
    autoplayTimer = undefined
  }

  /** Empties the board for the next conversation. The calendar and the offerings stay: they are the same for every one. */
  function reset(): void {
    const wasReplay = frozenAt.value !== undefined
    stopRun()
    scope.clear()
    replay.clear()
    runMode.value = 'idle'
    connection.value = 'idle'
    attempt.value = 0
    ending.value = undefined
    problem.value = undefined
    notice.value = undefined
    conversationId.value = undefined
    lines.value = []
    working.value = false
    state.value = undefined
    modelCalls.value = 0
    detail.value = undefined
    detailStatus.value = 'idle'
    unsent.value = undefined
    script.value = undefined
    frozenAt.value = undefined
    verificationRetried = false
    // The calendar a replay showed was a recording's; the real one is read again.
    if (wasReplay) {
      slots.value = new Map()
      calendarStatus.value = 'idle'
      void loadCalendar()
    }
  }

  /** Reads what this tab remembered of an earlier conversation, so the board can offer to pick it up. Nothing connects by itself. */
  function recallConversation(): void {
    remembered.value = rememberedConversation()
  }

  /** Forgets the offer to continue the earlier conversation. */
  function dismissRemembered(): void {
    remembered.value = undefined
    rememberConversation(undefined)
  }

  /** Opens a live conversation: after the check that the visitor is a person, which runs only now. Resumes `conversation` when given. */
  async function start(conversation?: string, sample?: ConversationSample): Promise<void> {
    if (connection.value === 'connecting' || connection.value === 'reconnecting') return
    reset()
    runMode.value = 'live'
    connection.value = 'connecting'
    const reading = generation
    if (sample) script.value = { sampleId: sample.id, turns: sample.turns, sent: 0, autoplay: false }
    if (!(await session.ensureVerified())) {
      if (reading !== generation) return
      runMode.value = 'idle'
      connection.value = 'idle'
      script.value = undefined
      problem.value = session.available ? (session.problem ?? verificationProblem()) : unavailableProblem()
      return
    }
    if (reading !== generation) return
    conversationId.value = conversation
    socket = newSocket()
    socket.open(conversation ?? null)
  }

  /** Picks the conversation up again after a close it survives. */
  function resume(): void {
    if (!socket || conversationId.value === undefined) return
    ending.value = undefined
    problem.value = undefined
    socket.resume()
  }

  /** Sends the visitor's message. The board shows it at once; the server's transcript replaces it if the connection has to be opened again. */
  function say(text: string): SayResult {
    const trimmed = text.trim()
    if (!canSay.value || !socket) return 'busy'
    const result = socket.send(trimmed)
    if (result === 'sent') {
      lines.value = [...lines.value, { id: numbers.next(), kind: 'visitor', text: trimmed }]
      working.value = true
      notice.value = undefined
      unsent.value = undefined
    }
    else if (result === 'not_open') {
      notice.value = 'not_open'
      unsent.value = trimmed
    }
    return result
  }

  /** The visitor ends the conversation. It stays on the server until it expires. */
  function endConversation(): void {
    stopScript()
    socket?.end()
  }

  // A sample sent to a live conversation.

  /** Sends the sample's next message, when the conversation can take it. */
  function sendNextScripted(): void {
    const current = script.value
    if (!current || current.sent >= current.turns.length || !canSay.value) return
    const turn = current.turns[current.sent]
    if (!turn) return
    if (say(turn.say) === 'sent') script.value = { ...current, sent: current.sent + 1 }
  }

  /** Sends the rest of the sample's messages one after another, each after the concierge has answered the one before. */
  function playScript(): void {
    const current = script.value
    if (!current) return
    script.value = { ...current, autoplay: true }
    sendNextScripted()
  }

  /** Stops sending the sample's messages by themselves. */
  function stopScript(): void {
    if (autoplayTimer !== undefined) clearTimeout(autoplayTimer)
    autoplayTimer = undefined
    const current = script.value
    if (current?.autoplay) script.value = { ...current, autoplay: false }
  }

  /** After an answer, sends the sample's next message if it is meant to go on by itself. */
  function continueScript(): void {
    const current = script.value
    if (!current?.autoplay) return
    if (current.sent >= current.turns.length) {
      stopScript()
      return
    }
    autoplayTimer = setTimeout(() => {
      autoplayTimer = undefined
      sendNextScripted()
    }, AUTOPLAY_PAUSE_MS)
  }

  // A recorded conversation.

  /** Applies one recorded exchange to the board, as if the server had just said it. */
  function applyExchange(exchange: Exchange): void {
    if (exchange.response.status < 200 || exchange.response.status >= 300) return
    const recorded = readRecordedExchange(exchange)
    if (recorded === undefined) return
    switch (recorded.kind) {
      case 'calendar':
        slots.value = slotsFromSnapshot(recorded.snapshot)
        frozenAt.value = Date.parse(recorded.snapshot.as_of)
        calendarStatus.value = 'ready'
        break
      case 'hello':
        onReady(recorded.ready, false)
        break
      case 'message':
        if (recorded.request.waitMinutes > 0) lines.value = [...lines.value, { id: numbers.next(), kind: 'pause', minutes: recorded.request.waitMinutes }]
        lines.value = [...lines.value, { id: numbers.next(), kind: 'visitor', text: recorded.request.text }]
        for (const event of recorded.turn.calendar) applyCalendarEvent(event)
        onReply(recorded.turn.reply, false)
        break
      case 'conversation':
        detail.value = recorded.detail
        detailStatus.value = 'ready'
        break
    }
  }

  /** Replays a recording: no request is made and nothing is spent. */
  function replayRecording(recording: Recording): void {
    reset()
    runMode.value = 'replay'
    connection.value = 'closed'
    replay.start(recording, (_, exchange) => applyExchange(exchange))
  }

  /** Shows a problem the board met outside a conversation, such as a recording that could not be read. */
  function fail(reason: ApiProblem): void {
    problem.value = reason
  }

  /** Tells the board the browser did not keep the session cookie that holds the check's result. */
  function cookieNotKept(): void {
    problem.value = cookieProblem()
  }

  /** Stops everything the board is doing, for when the visitor leaves it. */
  function dispose(): void {
    stopRun()
  }

  return {
    runMode,
    connection,
    attempt,
    ending,
    problem,
    notice,
    conversationId,
    lines,
    working,
    state,
    modelCalls,
    detail,
    detailStatus,
    unsent,
    script,
    remembered,
    slots,
    calendarStatus,
    recentlyChanged,
    lastChange,
    offerings,
    quota,
    open,
    messagesLeft,
    closed,
    canSay,
    runId,
    serverNow,
    loadOfferings,
    loadCalendar,
    loadQuota,
    recallConversation,
    dismissRemembered,
    start,
    resume,
    say,
    endConversation,
    sendNextScripted,
    playScript,
    stopScript,
    replayRecording,
    reset,
    fail,
    cookieNotKept,
    dispose,
  }
})
