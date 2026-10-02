<script setup lang="ts">
// LB-02's evaluation board. A visitor talks to the Basalt & Bean booking concierge in a phone-sized
// chat (a curated sample first, their own conversation after a quick check that they are a person)
// and watches the slot they ask for move on the live calendar from free to held to booked, with the
// time left on the hold counting down. The calendar is shared by everyone, so a second tab is a second
// visitor: the guide shows how to try to double-book a slot and why the database refuses it. The
// message the booking code wrote itself carries a receipt, the confirmation email is only recorded
// and never sent, and a conversation that needs a person is handed over with its transcript. A
// sample with a recording replays it for free, labelled as a replay. The conversation travels over a
// WebSocket; everything else is plain HTTP through the site's API.
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { LB02_SAMPLES } from '#shared/data/samples/lb02'
import type { ConversationSample } from '#shared/data/samples/lb02-types'
import { findSystemIn, isLocaleCode } from '#shared/data/datasheets'

import { ApiProblem, isApiProblem } from '~/board-kit/problem'
import type { PickerSample } from '~/board-kit/samples'
import { useReadingStore } from '~/stores/reading'
import { useReplayStore } from '~/stores/replay'
import { useSessionStore } from '~/stores/session'

import AppPanel from './components/AppPanel.vue'
import BookingStatus from './components/BookingStatus.vue'
import ChatComposer from './components/ChatComposer.vue'
import ChatLog from './components/ChatLog.vue'
import ConfirmationEmail from './components/ConfirmationEmail.vue'
import ConversationBar from './components/ConversationBar.vue'
import ConversationFacts from './components/ConversationFacts.vue'
import HandoffCard from './components/HandoffCard.vue'
import LiveCalendar from './components/LiveCalendar.vue'
import PhoneFrame from './components/PhoneFrame.vue'
import SampleScript from './components/SampleScript.vue'
import SecondTabGuide from './components/SecondTabGuide.vue'
import StartPanel from './components/StartPanel.vue'
import { useNow } from './now'
import { useOnline } from './online'
import { boardScope } from './pwa'
import { useLb02Store } from './store'
import { MAX_MESSAGE_LENGTH } from './wire'

const props = defineProps<{
  /** Builds the address of a run's permalink page in the visitor's language. */
  permalinkFor: (runId: string) => string
  /** The current time in Unix milliseconds, so the reset countdown can be tested. */
  now?: number
}>()

/** The system's number in the catalog and in the recordings' names. */
const SYSTEM = 'lb-02'

const { t, locale } = useI18n()
const session = useSessionStore()
const replay = useReplayStore()
const store = useLb02Store()
const { mode } = storeToRefs(useReadingStore())
const { runMode, connection, ending, problem, notice, lines, working, state, modelCalls, detail, detailStatus, unsent, script, remembered, slots, calendarStatus, recentlyChanged, lastChange, offerings, quota } = storeToRefs(store)

const code = computed(() => (isLocaleCode(locale.value) ? locale.value : 'en'))
const system = computed(() => findSystemIn(SYSTEM, code.value))
const brief = computed(() => mode.value === 'brief')

const clock = useNow()
const online = useOnline()
// The server's time, which moves every second: a hold's countdown and the calendar's lapsed holds are read from it.
const serverTime = computed(() => {
  void clock.value
  return store.serverNow()
})

const start = ref<InstanceType<typeof StartPanel>>()
const log = ref<InstanceType<typeof ChatLog>>()
const composer = ref<InstanceType<typeof ChatComposer>>()
const handoffCard = ref<InstanceType<typeof HandoffCard>>()

// What the visitor asked for last (an earlier conversation to pick up, a sample to run), so "try again" asks for the same.
const lastStart = ref<{ conversation?: string, sample?: ConversationSample }>({})

const samples = computed<PickerSample[]>(() => LB02_SAMPLES.map(sample => ({
  id: sample.id,
  title: t(`lb02.samples.${sample.id}.title`),
  note: t(`lb02.samples.${sample.id}.note`),
  language: sample.language,
  excerpt: sample.turns[0]?.say ?? '',
})))
const scripts: Readonly<Record<string, ConversationSample>> = Object.fromEntries(LB02_SAMPLES.map(sample => [sample.id, sample]))

const recorded = computed(() => replay.recorded[SYSTEM])
const available = computed(() => session.available)
const canRunLive = computed(() => available.value && (quota.value?.remaining ?? 1) > 0)
// The back end is there but the visitor has no conversation left today: the panel says so instead of blaming the site.
const allowanceUsedUp = computed(() => available.value && quota.value !== undefined && quota.value.remaining <= 0)
const unavailable = computed(() => session.loading === 'ready' && !session.available)
// The session's state could not be read at all: the site itself could not be reached.
const disconnected = computed(() => session.loading === 'failed')
const replaying = computed(() => runMode.value === 'replay' && replay.recording !== undefined)
const idle = computed(() => runMode.value === 'idle')
const busy = computed(() => runMode.value === 'live' && (connection.value === 'connecting' || connection.value === 'reconnecting'))

const chatLanguage = computed(() => state.value?.language ?? code.value)
const handedOver = computed(() => state.value?.step === 'handoff')
const booking = computed(() => state.value?.booking ?? null)
const hold = computed(() => state.value?.hold ?? null)
const permalink = computed(() => (runMode.value === 'live' && store.runId ? props.permalinkFor(store.runId) : undefined))
const phoneStatus = computed(() => (runMode.value === 'replay' ? 'replay' : connection.value))
const emptyText = computed(() => t(runMode.value === 'live' ? 'lb02.chat.emptyLive' : runMode.value === 'replay' ? 'lb02.chat.emptyReplay' : 'lb02.chat.empty'))
const noticeText = computed(() => (notice.value === undefined ? undefined : t(`lb02.notice.${notice.value}`, { max: MAX_MESSAGE_LENGTH })))

// What the message field is for now, from the state of the conversation and of the connection.
const composerMode = computed<'idle' | 'connecting' | 'ready' | 'finished' | 'ended' | 'replay' | 'offline'>(() => {
  if (runMode.value === 'idle') return 'idle'
  if (runMode.value === 'replay') return 'replay'
  if (store.closed) return 'finished'
  if (ending.value !== undefined || connection.value === 'closed') return 'ended'
  if (!online.value || connection.value === 'reconnecting') return 'offline'
  return connection.value === 'open' ? 'ready' : 'connecting'
})

/** Writes an offering's name in the visitor's language: the server's title once it is known, else the board's own. */
function titleOf(key: string): string {
  const named = offerings.value.find(offering => offering.key === key)
  if (named) return named.title[code.value]
  return t(`lb02.offeringNames.${key}`, key)
}

/** Opens a live conversation, a new one or one this tab left, and remembers what was asked for in case it has to be asked again. */
function open(conversation?: string, sample?: ConversationSample): void {
  lastStart.value = { conversation, sample }
  void store.start(conversation, sample)
}

/** Starts the visitor's own conversation. */
function begin(): void {
  open()
}

/** Runs a curated sample live. */
function runSample(id: string): void {
  open(undefined, LB02_SAMPLES.find(sample => sample.id === id))
}

/** Picks up the conversation this tab left. */
function resumeRemembered(): void {
  open(remembered.value)
}

/** Tries again after a failed check or a failed pass, as the same kind of conversation. */
function retry(): void {
  open(lastStart.value.conversation ?? store.conversationId, lastStart.value.sample)
}

/** Replays a sample's recording. */
async function replaySample(id: string): Promise<void> {
  try {
    store.replayRecording(await replay.read(SYSTEM, id))
    await nextTick()
    log.value?.focus()
  }
  catch (error) {
    store.fail(isApiProblem(error) ? error : new ApiProblem(404, 'not_found', 'There is nothing at this address.'))
  }
}

/** Plays the replay on the board again. */
function replayAgain(): void {
  if (!replay.recording) return
  store.replayRecording(replay.recording)
}

/** Runs the sample that is being replayed live instead. */
function runReplayedLive(): void {
  if (replay.recording) runSample(replay.recording.sample)
}

/** Sends what the visitor wrote. */
function send(text: string): void {
  store.say(text)
}

/** Empties the board and takes the visitor back to the start panel, with the keyboard's focus there. */
async function startOver(): Promise<void> {
  store.reset()
  await nextTick()
  start.value?.focus()
}

// Once a live conversation is open, the next thing the visitor does is write: the field takes the keyboard's focus.
watch(connection, async (status, before) => {
  if (status !== 'open' || before === 'open' || runMode.value !== 'live') return
  await nextTick()
  composer.value?.focus()
})

// When a person takes the conversation over, the message field goes, so the keyboard's focus moves to the handoff.
watch(handedOver, async (isHandedOver) => {
  if (!isHandedOver || runMode.value !== 'live') return
  await nextTick()
  handoffCard.value?.focus()
})

/** Reads the session, and what the board needs from the back end once the session says there is one. */
async function connect(): Promise<void> {
  await session.load()
  if (session.available) {
    void store.loadOfferings()
    void store.loadCalendar()
    void store.loadQuota()
  }
}

onMounted(async () => {
  // Stores outlive the page, so a visitor who comes back finds the board empty, not stuck on an old conversation.
  store.reset()
  store.recallConversation()
  void replay.loadList(SYSTEM)
  await connect()
})

onBeforeUnmount(() => {
  store.dispose()
})
</script>

<template>
  <BoardShell
    v-if="system"
    :part="system.part"
    :name="system.name"
    :state="runMode === 'replay' ? 'replay' : 'live'"
  >
    <p class="intro">
      {{ t('lb02.intro') }}
    </p>

    <BoardNotice
      v-if="unavailable"
      kind="unavailable"
    />

    <BoardNotice
      v-if="disconnected"
      :kind="session.problem?.kind ?? 'network'"
      retryable
      @retry="connect"
    />

    <BoardReplayBanner
      v-if="replaying && replay.recording"
      :recording="replay.recording"
      :playing="replay.playing"
      :can-run-live="canRunLive"
      @again="replayAgain"
      @live="runReplayedLive"
    />

    <BoardNotice
      v-if="problem && problem.kind !== 'verification'"
      :kind="problem.kind"
      :resets-at="problem.resetsAt ?? session.state?.resetsAt"
      :detail="problem.kind === 'rejected' ? problem.message : undefined"
    />

    <StartPanel
      v-if="idle"
      ref="start"
      :samples="samples"
      :scripts="scripts"
      :recorded="recorded"
      :busy="busy"
      :can-run-live="canRunLive"
      :allowance-used-up="allowanceUsedUp"
      :remembered="remembered"
      :title-of="titleOf"
      @replay="replaySample"
      @run-sample="runSample"
      @begin="begin"
      @resume="resumeRemembered"
      @forget="store.dismissRemembered()"
    />
    <ConversationBar
      v-else
      :mode="runMode === 'replay' ? 'replay' : 'live'"
      :ending="ending"
      :has-conversation="store.conversationId !== undefined"
      :finished="store.closed"
      @end="store.endConversation()"
      @again="startOver"
      @resume="store.resume()"
      @retry="retry"
    />

    <BoardTurnstileGate @retry="retry" />

    <div class="workspace">
      <div class="phone-column">
        <PhoneFrame
          :status="phoneStatus"
          :attempt="store.attempt"
        >
          <ChatLog
            ref="log"
            :lines="lines"
            :working="working"
            :language="chatLanguage"
            :brief="brief"
            :empty="emptyText"
          />
          <div class="dock">
            <BookingStatus
              :hold="hold"
              :booking="booking"
              :now="serverTime"
              :replay="runMode === 'replay'"
              :title-of="titleOf"
              email-href="#lb02-email"
            />
            <p
              v-if="noticeText"
              class="notice"
              role="alert"
              :data-notice="notice"
              data-testid="notice"
            >
              {{ noticeText }}
            </p>
            <ChatComposer
              ref="composer"
              :mode="composerMode"
              :working="working"
              :language="chatLanguage"
              :unsent="unsent"
              :messages-left="store.messagesLeft"
              @send="send"
            />
          </div>
        </PhoneFrame>
        <SampleScript
          v-if="script && runMode === 'live'"
          :script="script"
          :language="scripts[script.sampleId]?.language ?? code"
          :can-send="store.canSay"
          @next="store.sendNextScripted()"
          @all="store.playScript()"
          @stop="store.stopScript()"
        />
      </div>

      <LiveCalendar
        :slots="slots"
        :now="serverTime"
        :status="calendarStatus"
        :last-change="lastChange"
        :recently-changed="recentlyChanged"
        :offerings="offerings"
        :replay="runMode === 'replay'"
        :title-of="titleOf"
        @reload="store.loadCalendar()"
      />
    </div>

    <ConfirmationEmail
      v-if="booking"
      :confirmation="detail?.confirmation ?? null"
      :status="detailStatus"
    />

    <HandoffCard
      v-if="handedOver"
      ref="handoffCard"
      :handoff="detail?.handoff ?? null"
      :status="detailStatus"
      :language="chatLanguage"
    />

    <SecondTabGuide />

    <AppPanel
      :scope="boardScope(code)"
      :online="online"
    />

    <template #aside>
      <BoardLimitsPanel
        :limits="system.limits"
        :quota="quota"
        :quota-label="t('lb02.quotaLabel')"
        :brief="brief"
        :now="now"
      />
      <ConversationFacts
        :state="state"
        :model-calls="modelCalls"
        :brief="brief"
      />
    </template>

    <template #scope>
      <BoardScopePanel
        :brief="brief"
        :permalink="permalink"
      />
    </template>
  </BoardShell>
</template>

<style scoped>
.intro {
  max-width: 64ch;
  font-size: 15px;
}

.workspace {
  display: grid;
  grid-template-columns: minmax(0, 400px) minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}

.phone-column {
  display: grid;
  gap: 14px;
  min-width: 0;
}

.dock {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.notice {
  padding: 8px 12px;
  margin: 0 12px;
  font-size: 13px;
  background: var(--lb-shade);
  border: 1.5px solid var(--lb-ink);
}

@media (max-width: 880px) {
  .workspace {
    grid-template-columns: minmax(0, 1fr);
  }

  .phone-column {
    justify-items: center;
  }
}
</style>
