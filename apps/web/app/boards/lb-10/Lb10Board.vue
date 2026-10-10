<script setup lang="ts">
// LB-10's evaluation board: Eval Lab. A visitor picks one of the prompts behind the other systems (or a prepared edit
// of one), edits it in a plain text field that is checked as they type, chooses Groq, Workers AI or both, and runs their
// version and production's on the same ten cases of that system's golden set, after a quick check that they are a
// person; the run uses their one run of the day. The board follows the run by polling, then shows the report: the
// share of cases each prompt passed with its 95% interval as a figure, a table and words; the latency, the tokens and
// the calls, the cached ones said as such; the paired difference with production and its verdict; and every case that
// changed, with both replies and what each grader said. A prepared edit with a recording replays it for free, labelled
// as a replay. Below, what the nightly, the judge and the CI gate do, and what they have stored, which is nothing yet.
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { findSystemIn, isLocaleCode } from '#shared/data/datasheets'
import type { Lb10SampleId } from '#shared/data/samples/lb10'
import { ApiProblem, isApiProblem } from '~/board-kit/problem'
import { useReadingStore } from '~/stores/reading'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'
import MyRuns from './components/MyRuns.vue'
import NightlyPanel from './components/NightlyPanel.vue'
import ProblemNotice from './components/ProblemNotice.vue'
import PromptEditor from './components/PromptEditor.vue'
import ProviderChoice from './components/ProviderChoice.vue'
import ReportPanel from './components/ReportPanel.vue'
import RunProgress from './components/RunProgress.vue'
import SamplePanel from './components/SamplePanel.vue'
import TargetPicker from './components/TargetPicker.vue'
import { isRefusedPrompt } from './problems'
import { useLb10Store } from './store'
import './styles.css'

const props = defineProps<{
  /** Builds the address of a run's permalink page in the visitor's language. */
  permalinkFor: (runId: string) => string
  /** The current time in Unix milliseconds, so the reset countdown can be tested. */
  now?: number
}>()

/** The system's number in the catalog and in the recordings' names. */
const SYSTEM = 'lb-10'

const { t, locale } = useI18n()
const session = useSessionStore()
const scope = useScopeStore()
const replay = useReplayStore()
const store = useLb10Store()
const { mode } = storeToRefs(useReadingStore())
const { runMode, phase, problem, quota, run, stoppedWaiting, gaveUp, canRun, targets, busy } = storeToRefs(store)

const code = computed(() => (isLocaleCode(locale.value) ? locale.value : 'en'))
const system = computed(() => findSystemIn(SYSTEM, code.value))
const brief = computed(() => mode.value === 'brief')
const recorded = computed(() => replay.recorded[SYSTEM])
const available = computed(() => session.available)
const canRunLive = computed(() => available.value && canRun.value && (quota.value?.remaining ?? 1) > 0)
// The back end is there but the visitor has used today's run: the panel says so instead of blaming the site.
const allowanceUsedUp = computed(() => available.value && quota.value !== undefined && quota.value.remaining <= 0)
const unavailable = computed(() => session.loading === 'ready' && !session.available)
// The session's state could not be read at all: the site itself could not be reached.
const disconnected = computed(() => session.loading === 'failed')
const replaying = computed(() => runMode.value === 'replay' && replay.recording !== undefined)
const starting = computed(() => phase.value === 'starting' && runMode.value === 'live')
// The permalink exists for a live run only: a replay's run expired long ago.
const permalink = computed(() => (runMode.value === 'live' && scope.runId ? props.permalinkFor(scope.runId) : undefined))
const report = computed(() => (run.value?.state === 'done' ? run.value.report ?? undefined : undefined))
const shownProblem = computed(() => (problem.value && problem.value.kind !== 'verification' && !isRefusedPrompt(problem.value) ? problem.value : undefined))
// What the visitor last asked of the board, so "try again" after a failed check asks it again.
const lastAsk = ref<() => void>()

/**
 * Scrolls a part of the board into view if it is below the fold, since the panels above can push what an action
 * produces out of sight. It scrolls and nothing else: focus stays where the visitor put it, and a visitor who prefers
 * reduced motion gets no animation.
 */
async function bringIntoView(id: string): Promise<void> {
  await nextTick()
  const target = document.getElementById(id)
  if (!target || typeof target.scrollIntoView !== 'function') return
  if (target.getBoundingClientRect().top < window.innerHeight * 0.7) return
  const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' })
}

/** Runs the edit in the editor live. */
function runEdit(): void {
  lastAsk.value = runEdit
  void store.runLive().then(() => bringIntoView(store.refused ? 'lb10-editor' : 'lb10-run'))
}

/** Puts a prepared edit in the editor and runs it live. */
function runSample(id: Lb10SampleId): void {
  store.chooseSample(id)
  runEdit()
}

/** Puts a prepared edit in the editor, to change it further. */
function editSample(id: Lb10SampleId): void {
  store.chooseSample(id)
  void bringIntoView('lb10-editor')
}

/** Replays a prepared edit's recording. */
async function replaySample(id: Lb10SampleId): Promise<void> {
  try {
    store.replayRecording(await replay.read(SYSTEM, id), id)
    void bringIntoView('lb10-run')
  }
  catch (error) {
    store.showProblem(isApiProblem(error) ? error : new ApiProblem(404, 'not_found', 'There is nothing at this address.'))
  }
}

/** Plays the replay on the board again. */
function replayAgain(): void {
  const recording = replay.recording
  if (!recording) return
  store.replayRecording(recording, recording.sample)
  void bringIntoView('lb10-run')
}

/** Runs the prepared edit that is being replayed live instead. */
function runReplayedLive(): void {
  if (replay.recording) runSample(replay.recording.sample as Lb10SampleId)
}

/** Asks again what the visitor last asked, after a failed check. */
function retryCheck(): void {
  lastAsk.value?.()
}

/** Reads the session, and what the board needs from the back end once the session says there is one. */
async function connect(): Promise<void> {
  await session.load()
  if (session.available) await store.load()
}

onMounted(async () => {
  // Stores outlive the page, so a visitor who comes back finds the board fresh, not stuck on an old run or edit.
  store.clearAll()
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
      {{ t('lb10.intro') }}
    </p>
    <p
      v-if="!brief"
      class="lb10-hint"
    >
      {{ t('lb10.rules') }}
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
      v-if="shownProblem"
      :problem="shownProblem"
    />
    <p
      v-if="stoppedWaiting"
      class="lb10-hint"
      role="status"
      data-testid="stopped-waiting"
    >
      {{ t('lb10.run.stopped') }}
    </p>
    <p
      v-if="gaveUp"
      class="lb10-hint"
      role="status"
      data-testid="gave-up"
    >
      {{ t('lb10.run.gaveUp') }}
    </p>
    <SamplePanel
      :recorded="recorded"
      :busy="busy"
      :can-run-live="canRunLive"
      @replay="replaySample"
      @live="runSample"
      @edit="editSample"
    />
    <TargetPicker
      :brief="brief"
      :busy="busy"
    />
    <PromptEditor
      v-if="targets"
      :busy="busy"
    />
    <ProviderChoice
      v-if="targets"
      :can-run-live="canRunLive"
      :allowance-used-up="allowanceUsedUp"
      :unavailable="unavailable"
      @run="runEdit"
    />
    <BoardTurnstileGate @retry="retryCheck" />
    <p
      v-if="starting"
      class="lb10-hint"
      role="status"
      data-testid="starting"
    >
      {{ t('lb10.providers.starting') }}
    </p>
    <RunProgress />
    <template #aside>
      <BoardLimitsPanel
        :limits="system.limits"
        :quota="quota"
        :quota-label="t('lb10.quotaLabel')"
        :brief="brief"
        :now="now"
      />
      <MyRuns v-if="available" />
    </template>
    <template
      v-if="report || available"
      #wide
    >
      <ReportPanel
        v-if="report"
        :report="report"
        :brief="brief"
      />
      <NightlyPanel v-if="available" />
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
</style>
