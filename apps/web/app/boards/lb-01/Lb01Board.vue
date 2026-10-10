<script setup lang="ts">
// LB-01's evaluation board, the reference every other system's board follows. A visitor files a
// support ticket as a synthetic Basalt & Bean customer (a curated sample first, their own text
// after a quick check that they are a person), watches the pipeline work through the datasheet's
// nine steps while the Scope fills in, and then acts as the agent: reads the cited draft sentence
// by sentence, sees which claims failed their check and why, and approves, edits or escalates it.
// A sample with a recording replays it for free, labelled as a replay. The page polls and never
// streams, nothing is sent to a customer, and tickets are deleted after 24 hours.
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { LB01_SAMPLES } from '#shared/data/samples/lb01'
import { findSystemIn, isLocaleCode } from '#shared/data/datasheets'

import { ApiProblem, isApiProblem } from '~/board-kit/problem'
import type { PickerSample } from '~/board-kit/samples'
import { useReadingStore } from '~/stores/reading'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'

import AgentConsole from './components/AgentConsole.vue'
import PipelineSteps from './components/PipelineSteps.vue'
import StatsCounters from './components/StatsCounters.vue'
import TicketComposer from './components/TicketComposer.vue'
import { pipelineSteps } from './pipeline'
import { useLb01Store } from './store'
import type { NewTicket } from './store'

const props = defineProps<{
  /** Builds the address of a run's permalink page in the visitor's language. */
  permalinkFor: (runId: string) => string
  /** The current time in Unix milliseconds, so the reset countdown can be tested. */
  now?: number
}>()

/** The system's number in the catalog and in the recordings' names. */
const SYSTEM = 'lb-01'

const { t, locale } = useI18n()
const session = useSessionStore()
const scope = useScopeStore()
const replay = useReplayStore()
const store = useLb01Store()
const { mode } = storeToRefs(useReadingStore())
const { ticket, customers, customersStatus, runMode, phase, problem, decisionProblem, deciding, stats, quota, runOver, canDecide } = storeToRefs(store)

const code = computed(() => (isLocaleCode(locale.value) ? locale.value : 'en'))
const system = computed(() => findSystemIn(SYSTEM, code.value))
// The spans are named in English, so the English chain is what matches them; the visitor reads their own language's.
const english = findSystemIn(SYSTEM, 'en')
const brief = computed(() => mode.value === 'brief')

const samples = computed<PickerSample[]>(() => LB01_SAMPLES.map(sample => ({
  id: sample.id,
  title: t(`lb01.samples.${sample.id}.title`),
  note: t(`lb01.samples.${sample.id}.note`),
  language: sample.language,
  excerpt: sample.body,
})))
const sampleBodies = Object.fromEntries(LB01_SAMPLES.map(sample => [sample.id, sample.body]))

const recorded = computed(() => replay.recorded[SYSTEM])
const available = computed(() => session.available)
const canRunLive = computed(() => available.value && (quota.value?.remaining ?? 1) > 0)
// The back end is there but the visitor has no ticket left today: the composer says so instead of blaming the site.
const allowanceUsedUp = computed(() => available.value && quota.value !== undefined && quota.value.remaining <= 0)
const unavailable = computed(() => session.loading === 'ready' && !session.available)
// The session's state could not be read at all: the site itself could not be reached.
const disconnected = computed(() => session.loading === 'failed')
const replaying = computed(() => runMode.value === 'replay' && replay.recording !== undefined)

// The steps are read from the trace, so none can be called running, done or skipped before a span of
// the run has been seen, and a step with no span is called skipped only once the whole trace is in.
const unobserved = computed(() => scope.spans.length === 0)
const steps = computed(() => {
  const blind = phase.value === 'idle' || unobserved.value
  const marked = pipelineSteps(english?.chain ?? [], scope.spans, scope.phase === 'finished')
  return marked.map((step, index) => ({ label: system.value?.chain[index] ?? step.name, state: blind ? ('waiting' as const) : step.state }))
})
// A live run is going and its trace has not arrived: say why the steps are not marked yet.
const stepsPending = computed(() => runMode.value === 'live' && unobserved.value && (scope.phase === 'waiting' || scope.phase === 'following'))

// The permalink exists for a live run only: a replay's run expired long ago.
const permalink = computed(() => (runMode.value === 'live' && scope.runId ? props.permalinkFor(scope.runId) : undefined))

// The last ticket the visitor asked to file, so "try again" after a failed check files it.
const lastRequest = ref<NewTicket>()

/**
 * Scrolls a part of the board into view if it is below the fold, since a long composer can push
 * what a run produces out of sight. It scrolls and nothing else: focus stays where the visitor put
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

/** Shows the run's progress when it starts: the pipeline, or the console where the pipeline is left out. */
function revealRun(): Promise<void> {
  return bringIntoView(brief.value ? 'lb01-console' : 'lb01-pipeline')
}

/** Files a ticket live and remembers it, for a retry. */
function file(request: NewTicket): void {
  lastRequest.value = request
  void store.file(request).then(revealRun)
}

/** Runs a curated sample live, as its customer. */
function runSample(id: string): void {
  const sample = LB01_SAMPLES.find(candidate => candidate.id === id)
  if (sample) file({ customer: sample.customer, language: sample.language, body: sample.body })
}

/** Replays a sample's recording. */
async function replaySample(id: string): Promise<void> {
  try {
    store.replayRecording(await replay.read(SYSTEM, id))
    void revealRun()
  }
  catch (error) {
    store.fail(isApiProblem(error) ? error : new ApiProblem(404, 'not_found', 'There is nothing at this address.'))
  }
}

/** Plays the replay on the board again. */
function replayAgain(): void {
  if (!replay.recording) return
  store.replayRecording(replay.recording)
  void revealRun()
}

/** Runs the sample that is being replayed live instead. */
function runReplayedLive(): void {
  if (replay.recording) runSample(replay.recording.sample)
}

/** Tries the last ticket again after a failed check. */
function retryCheck(): void {
  if (lastRequest.value) void store.file(lastRequest.value)
}

// When the pipeline has finished with the ticket, the draft is what the visitor came for.
watch(() => store.finished, (done) => {
  if (done) void bringIntoView('lb01-console')
})

/** Reads the session, and what a board needs from the back end once the session says there is one. */
async function connect(): Promise<void> {
  await session.load()
  if (session.available) {
    void store.loadCustomers()
    void store.loadStats()
    void store.loadQuota()
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
      {{ t('lb01.intro') }}
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

    <TicketComposer
      :samples="samples"
      :recorded="recorded"
      :customers="customers"
      :busy="phase === 'filing' || (runMode === 'live' && phase === 'running')"
      :can-run-live="canRunLive"
      :allowance-used-up="allowanceUsedUp"
      :customers-failed="customersStatus === 'failed'"
      :default-language="code"
      :bodies="sampleBodies"
      @replay="replaySample"
      @run-sample="runSample"
      @file="file"
    />

    <BoardTurnstileGate @retry="retryCheck" />

    <section
      v-if="!brief"
      id="lb01-pipeline"
      class="pipeline"
      :aria-label="t('lb01.pipeline.title')"
    >
      <h2 class="lb-label">
        {{ t('lb01.pipeline.title') }}
      </h2>
      <p
        v-if="stepsPending"
        class="pending"
        data-testid="steps-pending"
      >
        {{ t('lb01.pipeline.unobserved') }}
      </p>
      <PipelineSteps :steps="steps" />
    </section>

    <AgentConsole
      id="lb01-console"
      :ticket="ticket"
      :working="Boolean(ticket) && !runOver && phase !== 'done'"
      :can-decide="canDecide"
      :replay="runMode === 'replay'"
      :deciding="deciding"
      :decision-problem="decisionProblem"
      @decide="(action, text) => store.decide(action, text)"
    />

    <template #aside>
      <BoardLimitsPanel
        :limits="system.limits"
        :quota="quota"
        :quota-label="t('lb01.quotaLabel')"
        :brief="brief"
        :now="now"
      />
      <StatsCounters :stats="stats" />
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

.pipeline,
#lb01-console {
  /* Leave room for the site's sticky toolbar when a run's results are scrolled into view. */
  scroll-margin-top: 72px;
}

.pipeline {
  display: grid;
  gap: 8px;
}

.pending {
  font-size: 13px;
  color: var(--lb-graphite);
}
</style>
