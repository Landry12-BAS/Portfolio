<script setup lang="ts">
// LB-07's evaluation board: the QA Engineer. A visitor switches on some of the staging shop's six bugs and
// gives a goal in plain words (a curated run first, or a goal of their own after a quick check that they
// are a person), and follows an agent that plans the test in one model call, runs it step by step in a
// sandboxed browser that can reach the shop and nothing else, re-plans when a step fails, makes its
// findings with code, has a model put them into bug reports, writes a Playwright test with a template and
// proves it red with the bugs on and green with them off. A curated run with a recording replays it for
// free, labelled as a replay. The page follows a live run by polling it; runs are deleted after an hour.
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { findSystemIn, isLocaleCode } from '#shared/data/datasheets'
import type { Lb07SampleId } from '#shared/data/samples/lb07'
import { ApiProblem, isApiProblem } from '~/board-kit/problem'
import { useReadingStore } from '~/stores/reading'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'
import type { Lb07BugId } from '@lb/contracts'
import EvidenceGallery from './components/EvidenceGallery.vue'
import FailurePanel from './components/FailurePanel.vue'
import FindingsPanel from './components/FindingsPanel.vue'
import MyRuns from './components/MyRuns.vue'
import ProblemNotice from './components/ProblemNotice.vue'
import ReportsPanel from './components/ReportsPanel.vue'
import RunPanel from './components/RunPanel.vue'
import StartPanel from './components/StartPanel.vue'
import StepList from './components/StepList.vue'
import TestCode from './components/TestCode.vue'
import VerificationPanel from './components/VerificationPanel.vue'
import { useLb07Store } from './store'
import './styles.css'

const props = defineProps<{
  /** Builds the address of a run's permalink page in the visitor's language. */
  permalinkFor: (runId: string) => string
  /** The current time in Unix milliseconds, so the reset countdown can be tested. */
  now?: number
}>()

/** The system's number in the catalog and in the recordings' names. */
const SYSTEM = 'lb-07'

const { t, locale } = useI18n()
const session = useSessionStore()
const scope = useScopeStore()
const replay = useReplayStore()
const store = useLb07Store()
const { mode } = storeToRefs(useReadingStore())
const { runMode, phase, problem, quota, run, stoppedWaiting } = storeToRefs(store)

const code = computed(() => (isLocaleCode(locale.value) ? locale.value : 'en'))
const system = computed(() => findSystemIn(SYSTEM, code.value))
const brief = computed(() => mode.value === 'brief')
const recorded = computed(() => replay.recorded[SYSTEM])
const available = computed(() => session.available)
const canRunLive = computed(() => available.value && (quota.value?.remaining ?? 1) > 0)
// The back end is there but the visitor has used today's runs: the panel says so instead of blaming the site.
const allowanceUsedUp = computed(() => available.value && quota.value !== undefined && quota.value.remaining <= 0)
const unavailable = computed(() => session.loading === 'ready' && !session.available)
// The session's state could not be read at all: the site itself could not be reached.
const disconnected = computed(() => session.loading === 'failed')
const replaying = computed(() => runMode.value === 'replay' && replay.recording !== undefined)
const starting = computed(() => phase.value === 'starting' && runMode.value === 'live')
// The permalink exists for a live run only: a replay's run expired long ago.
const permalink = computed(() => (runMode.value === 'live' && scope.runId ? props.permalinkFor(scope.runId) : undefined))
const ended = computed(() => run.value?.state === 'done')
// What the visitor last asked of the board, so "try again" after a failed check asks it again.
const lastAsk = ref<() => void>()

/**
 * Scrolls a part of the board into view if it is below the fold, since the start panel can push what an
 * action produces out of sight. It scrolls and nothing else: focus stays where the visitor put it, and a
 * visitor who prefers reduced motion gets no animation.
 */
async function bringIntoView(id: string): Promise<void> {
  await nextTick()
  const target = document.getElementById(id)
  if (!target || typeof target.scrollIntoView !== 'function') return
  if (target.getBoundingClientRect().top < window.innerHeight * 0.7) return
  const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' })
}

/** Runs a curated test run live. */
function runSample(id: Lb07SampleId): void {
  lastAsk.value = () => runSample(id)
  void store.runSample(id).then(() => bringIntoView('lb07-run'))
}

/** Runs the visitor's own goal with the bugs they switched on. */
function runOwn(goal: string, bugs: Lb07BugId[]): void {
  lastAsk.value = () => runOwn(goal, bugs)
  void store.runCustom(goal, bugs).then(() => bringIntoView('lb07-run'))
}

/** Replays a curated run's recording. */
async function replaySample(id: Lb07SampleId): Promise<void> {
  try {
    store.replayRecording(await replay.read(SYSTEM, id), { kind: 'sample', sampleId: id })
    void bringIntoView('lb07-run')
  }
  catch (error) {
    store.showProblem(isApiProblem(error) ? error : new ApiProblem(404, 'not_found', 'There is nothing at this address.'))
  }
}

/** Plays the replay on the board again. */
function replayAgain(): void {
  const recording = replay.recording
  if (!recording) return
  store.replayRecording(recording, { kind: 'sample', sampleId: recording.sample })
  void bringIntoView('lb07-run')
}

/** Runs the run that is being replayed live instead. */
function runReplayedLive(): void {
  if (replay.recording) runSample(replay.recording.sample as Lb07SampleId)
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
      {{ t('lb07.intro') }}
    </p>
    <p
      v-if="!brief"
      class="lb7-hint"
    >
      {{ t('lb07.sandbox') }}
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
    <ProblemNotice
      v-if="problem && problem.kind !== 'verification'"
      :problem="problem"
    />
    <p
      v-if="stoppedWaiting"
      class="lb7-hint"
      role="status"
      data-testid="stopped-waiting"
    >
      {{ t('lb07.run.stopped') }}
    </p>
    <p
      v-if="starting"
      class="lb7-hint"
      role="status"
      data-testid="starting"
    >
      {{ t('lb07.start.startingStatus') }}
    </p>
    <StartPanel
      :recorded="recorded"
      :busy="store.busy"
      :can-run-live="canRunLive"
      :allowance-used-up="allowanceUsedUp"
      :unavailable="unavailable"
      @replay="replaySample"
      @live="runSample"
      @own="runOwn"
    />
    <BoardTurnstileGate @retry="retryCheck" />
    <template #aside>
      <BoardLimitsPanel
        :limits="system.limits"
        :quota="quota"
        :quota-label="t('lb07.quotaLabel')"
        :brief="brief"
        :now="now"
      />
      <MyRuns />
    </template>
    <template
      v-if="run"
      #wide
    >
      <div
        id="lb07-run"
        class="stack"
      >
        <RunPanel :brief="brief" />
        <FailurePanel />
        <div class="pair">
          <StepList :brief="brief" />
          <div
            v-if="ended"
            class="column"
          >
            <FindingsPanel :brief="brief" />
            <ReportsPanel />
          </div>
        </div>
        <VerificationPanel :brief="brief" />
        <TestCode />
        <EvidenceGallery :brief="brief" />
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
.stack {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 20px;
  min-width: 0;
  /* Leave room for the site's sticky toolbar when the run is scrolled into view. */
  scroll-margin-top: 72px;
}
.pair {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr));
  gap: 20px;
  align-items: start;
}
.column {
  display: grid;
  gap: 20px;
  min-width: 0;
}
</style>
