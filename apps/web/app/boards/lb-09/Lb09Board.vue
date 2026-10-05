<script setup lang="ts">
// LB-09's evaluation board, the Meeting Recorder. A visitor plays a curated meeting (its recording
// replayed free, or run live after a quick check that they are a person) or records up to a minute
// of their own, chooses fast mode (the gateway's speech model) or private mode (faster-whisper on
// our own server), and follows the worker stage by stage over the API's WebSocket: decoding,
// transcribing, labelling, extracting, aligning. When the meeting is done the transcript appears
// with the speaker labels the words suggest, and the decisions and actions with their verbatim
// evidence: a click on any of them jumps the player to the second it was said. The audio plays from
// the browser (the sample's file on the site, or the visitor's recording held in the page), because
// the back end deletes it once transcribed. The export panel writes the result as JSON, CSV or the
// plain-English follow-up for Automation Studio (LB-08). The visitor's meetings of the last 24 hours
// are listed beside the board, so a reload or another tab opens them again. A live region says each
// stage as the worker reaches it. The two board pages are the only ones whose Permissions-Policy
// allows the microphone (docs/SECURITY.md, section 3).
import { LbIcon } from '@lb/icons'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { findSystemIn, isLocaleCode } from '#shared/data/datasheets'
import { LB09_SAMPLES } from '#shared/data/samples/lb09'

import { ApiProblem, isApiProblem } from '~/board-kit/problem'
import type { PickerSample } from '~/board-kit/samples'
import { useReadingStore } from '~/stores/reading'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'

import type { Recording } from './audio'
import AudioPlayer from './components/AudioPlayer.vue'
import ExportPanel from './components/ExportPanel.vue'
import ItemsList from './components/ItemsList.vue'
import MeetingFacts from './components/MeetingFacts.vue'
import MyMeetings from './components/MyMeetings.vue'
import ProgressSteps from './components/ProgressSteps.vue'
import RecorderPanel from './components/RecorderPanel.vue'
import SamplePanel from './components/SamplePanel.vue'
import type { SampleFacts } from './components/SamplePanel.vue'
import TranscriptView from './components/TranscriptView.vue'
import { MODES, WORK_STAGES } from './schemas'
import type { Stage } from './schemas'
import { useLb09Store } from './store'

const props = defineProps<{
  /** Builds the address of a run's permalink page in the visitor's language. */
  permalinkFor: (runId: string) => string
  /** The current time in Unix milliseconds, so the countdowns can be tested. */
  now?: number
}>()

/** Where the meeting comes from: a curated sample, or the visitor's microphone. */
type Source = 'sample' | 'record'

/** The system's number in the catalog and in the recordings' names. */
const SYSTEM = 'lb-09'

/** The part of the page that holds what a meeting produces, which is scrolled into view when one starts. */
const RUN_ID = 'lb09-run'

const { t, locale } = useI18n()
const session = useSessionStore()
const scope = useScopeStore()
const replay = useReplayStore()
const store = useLb09Store()
const { mode: reading } = storeToRefs(useReadingStore())
const { quota, source: meetingSource, mode, runMode, phase, feed, meeting, stages, transcript, items, playback, problem, startedAt, gaveUp } = storeToRefs(store)

const code = computed(() => (isLocaleCode(locale.value) ? locale.value : 'en'))
const system = computed(() => findSystemIn(SYSTEM, code.value))
const brief = computed(() => reading.value === 'brief')

const sourceChoice = ref<Source>('sample')
const sourceOptions = computed(() => [
  { value: 'sample' as const, label: t('lb09.source.sample') },
  { value: 'record' as const, label: t('lb09.source.record') },
])
const modeOptions = computed(() => MODES.map(value => ({ value, label: t(`lb09.modes.${value}`) })))

// The curated meetings are spoken in English; the cards' words are the visitor's.
const samples = computed<PickerSample[]>(() => LB09_SAMPLES.map(sample => ({
  id: sample.id,
  title: t(`lb09.samples.names.${sample.id}.title`),
  note: t(`lb09.samples.names.${sample.id}.note`),
  language: sample.language,
  excerpt: sample.about,
})))
const sampleFacts = computed<Record<string, SampleFacts>>(() => Object.fromEntries(LB09_SAMPLES.map(sample => [sample.id, { seconds: sample.seconds, speakers: sample.speakers, decisions: sample.decisions, actions: sample.actions }])))
const selectedSample = ref<string | undefined>(LB09_SAMPLES[0]?.id)

const recorded = computed(() => replay.recorded[SYSTEM])
const available = computed(() => session.available)
const canRunLive = computed(() => available.value && (quota.value?.remaining ?? 1) > 0)
// The back end is there but the visitor has no recording left today: the panels say so instead of blaming the site.
const allowanceUsedUp = computed(() => available.value && quota.value !== undefined && quota.value.remaining <= 0)
const unavailable = computed(() => session.loading === 'ready' && !session.available)
// The session's state could not be read at all: the site itself could not be reached.
const disconnected = computed(() => session.loading === 'failed')
const replaying = computed(() => runMode.value === 'replay' && replay.recording !== undefined)
const working = computed(() => phase.value === 'starting' || phase.value === 'working')
// A live meeting is going: another cannot be started until it is done, but a replay may be started at any time.
const busy = computed(() => runMode.value === 'live' && working.value)
const done = computed(() => phase.value === 'done' && transcript.value !== undefined && items.value !== undefined)
// The meeting itself failed (the worker said so), as opposed to the site failing to start it.
const meetingFailed = computed(() => phase.value === 'failed' && meeting.value !== undefined && meeting.value.status === 'failed')
const shownProblem = computed(() => (problem.value && problem.value.kind !== 'verification' ? problem.value : undefined))

// The permalink exists for a live run only: a replay's run expired long ago.
const permalink = computed(() => (runMode.value === 'live' && scope.runId ? props.permalinkFor(scope.runId) : undefined))

// The player, and the second it is at, for the transcript to mark what is being heard.
const player = ref<InstanceType<typeof AudioPlayer>>()
const currentTime = ref(0)
const playerLabel = computed(() => (meetingSource.value?.kind === 'upload' ? t('lb09.player.own') : t('lb09.player.sample')))

// The visitor's own recording, opened again from the list: only the page that sent it held its audio, and the
// service deleted it once transcribed, so there is nothing to play.
const audioGone = computed(() => meetingSource.value?.kind === 'upload' && playback.value === undefined && meeting.value !== undefined)

/** Says the stage a meeting is at, as the live region announces it: the stage and that it runs, or that it waits for the worker. */
function stageWords(stage: Stage, status: string): string {
  if (status === 'received') return t('lb09.progress.queued')
  const work = WORK_STAGES.find(candidate => candidate === stage)
  return work === undefined ? t('lb09.progress.title') : t('lb09.progress.now', { stage: t(`lb09.progress.stages.${work}`) })
}

// A persistent live region, so the work and the result are announced to a screen reader in turn: every stage the
// worker reaches, in words, then the outcome.
const announcement = computed(() => {
  if (phase.value === 'starting') return t('lb09.progress.checking')
  if (phase.value === 'working') {
    if (runMode.value === 'replay') return t('lb09.progress.replaying')
    return meeting.value ? stageWords(meeting.value.stage, meeting.value.status) : t('lb09.progress.title')
  }
  if (done.value) return t('lb09.progress.done')
  if (meetingFailed.value) return t('lb09.progress.failedTitle')
  if (gaveUp.value) return t('lb09.progress.gaveUp')
  return ''
})

// The last thing the visitor asked for, so "try again" after a failed check asks for it again.
const lastRequest = ref<() => void>()

/**
 * Scrolls a part of the board into view if it is below the fold. It scrolls and nothing else: focus stays
 * where the visitor put it, and a visitor who prefers reduced motion gets no animation.
 */
async function bringIntoView(id: string): Promise<void> {
  await nextTick()
  const target = document.getElementById(id)
  if (!target || typeof target.scrollIntoView !== 'function') return
  if (target.getBoundingClientRect().top < window.innerHeight * 0.7) return
  const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' })
}

/** Finds a curated sample by its ID. */
function sampleCalled(id: string) {
  return LB09_SAMPLES.find(candidate => candidate.id === id)
}

/** Runs a curated meeting live. */
function runSample(id: string): void {
  const sample = sampleCalled(id)
  if (!sample) return
  lastRequest.value = () => runSample(id)
  void store.startSample(sample.id, sample.file, sample.language)
}

/** Sends the visitor's recording. */
function sendRecording(recording: Recording, url: string): void {
  lastRequest.value = undefined
  void store.startUpload(recording, url)
  void bringIntoView(RUN_ID)
}

/** Replays a recording of a curated meeting. */
async function replayRecorded(id: string): Promise<void> {
  const sample = sampleCalled(id)
  if (!sample) return
  try {
    store.replayRecording(await replay.read(SYSTEM, id), sample.id, sample.file)
    void bringIntoView(RUN_ID)
  }
  catch (error) {
    store.report(isApiProblem(error) ? error : new ApiProblem(404, 'not_found', 'There is nothing at this address.'))
  }
}

/** Plays the replay on the board again. */
function replayAgain(): void {
  const current = meetingSource.value
  if (replay.recording && current?.sampleId) {
    const sample = sampleCalled(current.sampleId)
    if (sample) store.replayRecording(replay.recording, sample.id, sample.file)
  }
}

/** Runs the meeting that is being replayed live instead. */
function runReplayedLive(): void {
  const current = meetingSource.value
  if (current?.sampleId) runSample(current.sampleId)
}

/** Asks for the last thing again, after a failed check. */
function askAgain(): void {
  lastRequest.value?.()
}

/** Jumps the player to a second, and plays from there when asked. */
function seek(seconds: number, play: boolean): void {
  player.value?.seekTo(seconds, play)
}

// A live meeting is shown once it has been sent: before that the check that the visitor is a person may
// still open and close above it, and the page would be scrolled to where the meeting was a moment ago.
watch(startedAt, (sent) => {
  if (sent !== undefined) void bringIntoView(RUN_ID)
})
// When the result is in, it is what the visitor came for. A failure is announced where the run would be.
watch(phase, (next) => {
  if (next === 'done') void bringIntoView('lb09-result')
  else if (next === 'failed') void bringIntoView(RUN_ID)
})
// The player starts over with each meeting.
watch(playback, () => {
  currentTime.value = 0
})

/** Reads the session, and what a board needs from the back end once the session says there is one. */
async function connect(): Promise<void> {
  await session.load()
  if (session.available) {
    void store.loadLimits()
    void store.loadMine()
  }
}

onMounted(async () => {
  // Stores outlive the page, so a visitor who comes back finds the board empty, not stuck on an old run.
  store.reset()
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
      {{ t('lb09.intro') }}
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

    <div class="choices">
      <LbSegmented
        v-model="sourceChoice"
        class="switch"
        :options="sourceOptions"
        :label="t('lb09.source.label')"
      />
      <div class="mode">
        <LbSegmented
          v-model="mode"
          class="switch"
          :options="modeOptions"
          :label="t('lb09.modes.label')"
        />
        <p
          class="mode-note"
          data-testid="mode-note"
        >
          {{ t(`lb09.modes.${mode}Note`) }}
        </p>
      </div>
    </div>

    <!-- Each side keeps what the visitor chose and recorded while the other is open. -->
    <KeepAlive>
      <SamplePanel
        v-if="sourceChoice === 'sample'"
        v-model="selectedSample"
        :samples="samples"
        :recorded="recorded"
        :facts="sampleFacts"
        :busy="busy"
        :can-run-live="canRunLive"
        :allowance-used-up="allowanceUsedUp"
        @replay="replayRecorded"
        @run="runSample"
      />
      <RecorderPanel
        v-else
        :busy="busy"
        :can-run-live="canRunLive"
        :allowance-used-up="allowanceUsedUp"
        @send="sendRecording"
      />
    </KeepAlive>

    <BoardTurnstileGate @retry="askAgain" />

    <p
      class="lb-sr-only"
      role="status"
      data-testid="announcement"
    >
      {{ announcement }}
    </p>

    <div
      :id="RUN_ID"
      class="run"
    >
      <BoardNotice
        v-if="shownProblem"
        :kind="shownProblem.kind"
        :resets-at="shownProblem.resetsAt ?? session.state?.resetsAt"
        :detail="shownProblem.kind === 'rejected' ? shownProblem.message : undefined"
      />

      <BoardReplayBanner
        v-if="replaying && replay.recording"
        :recording="replay.recording"
        :playing="replay.playing"
        :can-run-live="canRunLive"
        @again="replayAgain"
        @live="runReplayedLive"
      />

      <p
        v-if="phase === 'starting'"
        class="checking"
        data-testid="checking"
      >
        {{ t('lb09.progress.checking') }}
      </p>

      <ProgressSteps
        v-if="meeting && (working || meetingFailed)"
        :stages="stages"
        :current="meeting.stage"
        :status="meeting.status"
        :failure="meeting.failure"
        :mode="meeting.mode"
        :feed="feed"
        :replaying="runMode === 'replay'"
        :started-at="startedAt"
        :now="now"
      />

      <div
        v-if="gaveUp"
        class="gave-up"
        data-testid="gave-up"
        role="note"
      >
        <LbIcon
          name="clock"
          :size="18"
        />
        <div>
          <p class="gave-up-title">
            {{ t('lb09.progress.gaveUp') }}
          </p>
          <p>{{ t('lb09.progress.gaveUpNote') }}</p>
        </div>
      </div>

      <div
        v-if="playback && (working || done || meetingFailed)"
        class="playback"
        data-testid="playback"
      >
        <p class="lb-label">
          {{ playerLabel }}
        </p>
        <AudioPlayer
          ref="player"
          :src="playback.url"
          :label="playerLabel"
          @time="currentTime = $event"
        />
      </div>
      <p
        v-else-if="audioGone && (working || done)"
        class="audio-gone"
        data-testid="audio-gone"
      >
        {{ t('lb09.player.gone') }}
      </p>

      <div
        v-if="done && transcript && items && meeting"
        id="lb09-result"
        class="result"
      >
        <ItemsList
          :items="items"
          @play="seek($event, true)"
        />
        <TranscriptView
          :transcript="transcript"
          :current-time="currentTime"
          @seek="seek($event, false)"
        />
        <ExportPanel
          v-if="!brief"
          :meeting="meeting"
          :segments="transcript.segments"
          :items="items.items"
        />
      </div>
    </div>

    <template #aside>
      <BoardLimitsPanel
        :limits="system.limits"
        :quota="quota"
        :quota-label="t('lb09.quotaLabel')"
        :brief="brief"
        :now="now"
      />
      <MeetingFacts
        :meeting="meeting"
        :brief="brief"
      />
      <MyMeetings v-if="available" />
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

.choices {
  display: grid;
  gap: 12px;
}

/* The switches are rows of buttons, not bars across the column. */
.switch {
  justify-self: start;
}

.mode {
  display: grid;
  gap: 6px;
}

.mode-note {
  max-width: 64ch;
  font-size: 13px;
  color: var(--lb-graphite);
}

.run {
  display: grid;
  gap: 16px;
  min-width: 0;
  /* Leave room for the site's sticky toolbar when a meeting's results are scrolled into view. */
  scroll-margin-top: 72px;
}

.checking {
  font-size: 14px;
}

.playback {
  display: grid;
  gap: 6px;
}

.gave-up {
  display: flex;
  gap: 10px;
  padding: 12px 14px;
  font-size: 14px;
  border: 1px solid var(--lb-rule);
}

.gave-up-title {
  font-weight: 700;
}

.audio-gone {
  max-width: 64ch;
  font-size: 13px;
  color: var(--lb-graphite);
}

.result {
  display: grid;
  gap: 24px;
  min-width: 0;
  scroll-margin-top: 72px;
}
</style>
