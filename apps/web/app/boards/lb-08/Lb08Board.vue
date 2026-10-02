<script setup lang="ts">
// LB-08's evaluation board: the Automation Studio. A visitor describes a business process of
// Basalt & Bean (a curated sample first, their own words after a quick check that they are a
// person), gets a workflow they can edit on a canvas or in an outline with every edit checked live by
// the same rules that check what the model writes, saves it as a new version, and runs it with a
// test order. They can make a step fail on purpose and watch the retries, the dead-letter queue and
// the replay, and see that what the sandbox "sent" went out once. A sample with a recording replays
// it for free, labelled as a replay. The page polls and never streams; workflows, runs and
// deliveries are deleted after 24 hours.
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { LB08_SAMPLES } from '#shared/data/samples/lb08'
import { findSystemIn, isLocaleCode } from '#shared/data/datasheets'

import { ApiProblem, isApiProblem } from '~/board-kit/problem'
import type { PickerSample } from '~/board-kit/samples'
import { useReadingStore } from '~/stores/reading'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'

import ApprovalPrompt from './components/ApprovalPrompt.vue'
import DeadLetters from './components/DeadLetters.vue'
import DescribeComposer from './components/DescribeComposer.vue'
import MyWorkflows from './components/MyWorkflows.vue'
import ProblemNotice from './components/ProblemNotice.vue'
import RunLog from './components/RunLog.vue'
import RunPanel from './components/RunPanel.vue'
import RunProgress from './components/RunProgress.vue'
import SentPanel from './components/SentPanel.vue'
import VersionList from './components/VersionList.vue'
import WorkflowEditor from './components/WorkflowEditor.vue'
import { useLb08Store } from './store'
import './styles.css'

const props = defineProps<{
  /** Builds the address of a run's permalink page in the visitor's language. */
  permalinkFor: (runId: string) => string
  /** The current time in Unix milliseconds, so the reset countdown can be tested. */
  now?: number
}>()

/** The system's number in the catalog and in the recordings' names. */
const SYSTEM = 'lb-08'

const { t, locale } = useI18n()
const session = useSessionStore()
const scope = useScopeStore()
const replay = useReplayStore()
const store = useLb08Store()
const { mode } = storeToRefs(useReadingStore())
const { runMode, busy, problem, limits, quota, workflow, currentRun } = storeToRefs(store)

const code = computed(() => (isLocaleCode(locale.value) ? locale.value : 'en'))
const system = computed(() => findSystemIn(SYSTEM, code.value))
const brief = computed(() => mode.value === 'brief')

const samples = computed<PickerSample[]>(() => LB08_SAMPLES.map(sample => ({
  id: sample.id,
  title: t(`lb08.samples.${sample.id}.title`),
  note: t(`lb08.samples.${sample.id}.note`),
  language: sample.language,
  excerpt: sample.description,
})))
const sampleBodies = Object.fromEntries(LB08_SAMPLES.map(sample => [sample.id, sample.description]))

const recorded = computed(() => replay.recorded[SYSTEM])
const available = computed(() => session.available)
const descriptionsLeft = computed(() => limits.value?.generations.remaining)
const canDescribe = computed(() => available.value && (descriptionsLeft.value ?? 1) > 0)
// The back end is there but the visitor has no descriptions left today: the composer says so instead of blaming the site.
const allowanceUsedUp = computed(() => available.value && descriptionsLeft.value !== undefined && descriptionsLeft.value <= 0)
const canRunLive = computed(() => available.value && (quota.value?.remaining ?? 1) > 0)
const unavailable = computed(() => session.loading === 'ready' && !session.available)
// The session's state could not be read at all: the site itself could not be reached.
const disconnected = computed(() => session.loading === 'failed')
const replaying = computed(() => runMode.value === 'replay' && replay.recording !== undefined)
const generations = computed(() => limits.value?.generations)
const opened = computed(() => workflow.value !== undefined)

// The permalink exists for a live run only: a replay's run expired long ago.
const permalink = computed(() => (runMode.value === 'live' && scope.runId ? props.permalinkFor(scope.runId) : undefined))

// What the visitor last asked of the board, so "try again" after a failed check asks it again.
const lastAsk = ref<() => void>()

/**
 * Scrolls a part of the board into view if it is below the fold, since the composer can push what
 * an action produces out of sight. It scrolls and nothing else: focus stays where the visitor put
 * it, and a visitor who prefers reduced motion gets no animation.
 */
async function bringIntoView(id: string): Promise<void> {
  await nextTick()
  const target = document.getElementById(id)
  if (!target || typeof target.scrollIntoView !== 'function') return
  if (target.getBoundingClientRect().top < window.innerHeight * 0.7) return
  const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' })
}

/** Shows the editor when a workflow has been opened. */
function revealEditor(): Promise<void> {
  return bringIntoView('lb08-editor')
}

/** Opens a curated sample live, with its own test order. */
function openLive(id: string): void {
  const sample = LB08_SAMPLES.find(candidate => candidate.id === id)
  if (!sample) return
  lastAsk.value = () => openLive(id)
  void store.openSample(sample.id, sample.input).then(revealEditor)
}

/** Has the model write a workflow from the visitor's words. */
function describe(description: string): void {
  lastAsk.value = () => describe(description)
  void store.describe(description).then(revealEditor)
}

/** Starts a run with the test order, and brings its progress into view. */
function startRun(): void {
  lastAsk.value = startRun
  void store.startRun().then(() => bringIntoView('lb08-progress'))
}

/** Replays a sample's recording. */
async function replaySample(id: string): Promise<void> {
  try {
    store.replayRecording(await replay.read(SYSTEM, id))
    void revealEditor()
  }
  catch (error) {
    store.report(isApiProblem(error) ? error : new ApiProblem(404, 'not_found', 'There is nothing at this address.'))
  }
}

/** Plays the replay on the board again. */
function replayAgain(): void {
  if (!replay.recording) return
  store.replayRecording(replay.recording)
  void revealEditor()
}

/** Opens the sample that is being replayed live instead. */
function openReplayedLive(): void {
  if (replay.recording) openLive(replay.recording.sample)
}

/** Asks again what the visitor last asked, after a failed check. */
function retryCheck(): void {
  lastAsk.value?.()
}

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
      {{ t('lb08.intro') }}
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
      @live="openReplayedLive"
    />

    <ProblemNotice
      v-if="problem && problem.kind !== 'verification'"
      :problem="problem"
      :brief="brief"
    />

    <DescribeComposer
      :samples="samples"
      :recorded="recorded"
      :busy="busy !== 'idle'"
      :can-open-live="available"
      :can-describe="canDescribe"
      :allowance-used-up="allowanceUsedUp"
      :bodies="sampleBodies"
      :descriptions-left="descriptionsLeft"
      @replay="replaySample"
      @open-live="openLive"
      @describe="describe"
    />

    <BoardTurnstileGate @retry="retryCheck" />

    <template #aside>
      <BoardLimitsPanel
        :limits="system.limits"
        :quota="quota"
        :quota-label="t('lb08.quotaLabel')"
        :brief="brief"
        :now="now"
      />
      <section
        v-if="generations"
        class="lb8-panel"
        :aria-label="t('lb08.descriptionsLabel')"
        data-testid="generations"
      >
        <p class="count">
          <span>{{ t('lb08.descriptionsLabel') }}</span>
          <strong>{{ t('board.limits.count', { left: generations.remaining, total: generations.limit }) }}</strong>
        </p>
      </section>
      <MyWorkflows />
      <VersionList :permalink-for="permalinkFor" />
    </template>

    <template
      v-if="opened"
      #wide
    >
      <WorkflowEditor :brief="brief" />
      <RunPanel @start="startRun" />
      <div
        id="lb08-progress"
        class="progress"
      >
        <ApprovalPrompt />
        <RunProgress :brief="brief" />
        <SentPanel
          v-if="currentRun"
          :brief="brief"
        />
        <DeadLetters :brief="brief" />
        <RunLog :brief="brief" />
      </div>
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

.progress {
  display: grid;
  gap: 20px;
  /* Leave room for the site's sticky toolbar when a run's progress is scrolled into view. */
  scroll-margin-top: 72px;
}

.count {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: baseline;
  justify-content: space-between;
  font-size: 13.5px;
}
</style>
