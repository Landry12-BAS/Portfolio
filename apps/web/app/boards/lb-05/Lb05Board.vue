<script setup lang="ts">
// LB-05's evaluation board, the Data Analyst. A visitor asks a business question about Basalt & Bean's
// sales in plain words (a curated question first, their own text after a quick check that they are a
// person), waits while the analyst works, which is one request that can take up to 90 seconds, and then
// reads the answer: the explanation, the SQL that ran, the table, a chart and the chain of steps read
// from the Scope's trace. The second way in is the safety demo: pick an attack, or write one, and see
// which of six layers stopped it. A question with a recording replays it for free, labelled as a
// replay; one without says so and offers the live run, which spends one of the day's 25 questions.
// The page never streams: it counts the wait honestly and shows the steps when the answer is in.
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { findSystemIn, isLocaleCode } from '#shared/data/datasheets'
import { LB05_ATTACKS, LB05_SAMPLES } from '#shared/data/samples/lb05'

import { ApiProblem, isApiProblem } from '~/board-kit/problem'
import type { PickerSample } from '~/board-kit/samples'
import { useReadingStore } from '~/stores/reading'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'

import { attackItems } from './attacks'
import AnswerView from './components/AnswerView.vue'
import AskNotice from './components/AskNotice.vue'
import AskProgress from './components/AskProgress.vue'
import QuestionComposer from './components/QuestionComposer.vue'
import SafetyPanel from './components/SafetyPanel.vue'
import SemanticBrowser from './components/SemanticBrowser.vue'
import { pipelineSteps } from './pipeline'
import { useLb05Store } from './store'
import type { AskRequest, AskSource } from './store'
import { layerVerdicts } from './verdict'

const props = defineProps<{
  /** Builds the address of a run's permalink page in the visitor's language. */
  permalinkFor: (runId: string) => string
  /** The current time in Unix milliseconds, so the reset countdown can be tested. */
  now?: number
}>()

/** What the visitor is doing: asking a question, or trying to break the analyst. */
type Doing = 'ask' | 'attack'

/** The system's number in the catalog and in the recordings' names. */
const SYSTEM = 'lb-05'

/** The part of the page that holds what a question produces, which is scrolled into view when one starts. */
const RUN_ID = 'lb05-run'

const { t, locale } = useI18n()
const session = useSessionStore()
const scope = useScopeStore()
const replay = useReplayStore()
const store = useLb05Store()
const { mode: reading } = storeToRefs(useReadingStore())
const { quota, limits, layer, layerStatus, asked, runMode, phase, askedAt, answer, problem, stoppedWaiting } = storeToRefs(store)

const code = computed(() => (isLocaleCode(locale.value) ? locale.value : 'en'))
const system = computed(() => findSystemIn(SYSTEM, code.value))
const brief = computed(() => reading.value === 'brief')

const doing = ref<Doing>('ask')
const doingOptions = computed(() => [
  { value: 'ask' as const, label: t('lb05.modes.ask') },
  { value: 'attack' as const, label: t('lb05.modes.attack') },
])

// The curated questions are English, as the semantic layer's names are; the cards' words are the visitor's.
const questions = computed<PickerSample[]>(() => LB05_SAMPLES.map(sample => ({
  id: sample.id,
  title: t(`lb05.samples.${sample.id}.title`),
  note: t(`lb05.samples.${sample.id}.note`),
  language: 'en',
  excerpt: sample.question,
})))
const attacks = computed(() => attackItems(key => t(key)))

const recorded = computed(() => replay.recorded[SYSTEM])
const available = computed(() => session.available)
const canRunLive = computed(() => available.value && (quota.value?.remaining ?? 1) > 0)
// The back end is there but the visitor has no question left today: the composer says so instead of blaming the site.
const allowanceUsedUp = computed(() => available.value && quota.value !== undefined && quota.value.remaining <= 0)
const unavailable = computed(() => session.loading === 'ready' && !session.available)
// The session's state could not be read at all: the site itself could not be reached.
const disconnected = computed(() => session.loading === 'failed')
const replaying = computed(() => runMode.value === 'replay' && replay.recording !== undefined)
const asking = computed(() => phase.value === 'asking')
// A live question is going: another cannot be asked until it is done, but a replay may be started at any time.
const busy = computed(() => runMode.value === 'live' && asking.value)

// The steps are read from the trace, so none can be called running, done or skipped before a span of
// the run has been seen, and a step with no span is called skipped only once the whole trace is in.
const steps = computed(() => pipelineSteps(scope.spans, scope.phase === 'finished'))
const stepLabels = computed(() => system.value?.chain ?? [])
const stepsBlind = computed(() => scope.spans.length === 0)
// The trace was looked for and is not there, so the steps will not be marked at all.
const traceLost = computed(() => stepsBlind.value && (scope.phase === 'missing' || scope.phase === 'failed'))

// The permalink exists for a live run only: a replay's run expired long ago.
const permalink = computed(() => (runMode.value === 'live' && scope.runId ? props.permalinkFor(scope.runId) : undefined))

// The safety demo reads which layer stopped the query from the answer's own fields, for attacks only.
const attackAnswer = computed(() => (asked.value?.source === 'attack' || asked.value?.source === 'own-attack' ? answer.value : undefined))
const verdicts = computed(() => (attackAnswer.value && attackAnswer.value.outcome !== 'unavailable' ? layerVerdicts(attackAnswer.value) : undefined))
const noQuery = computed(() => attackAnswer.value !== undefined && attackAnswer.value.attempts.length === 0)

// A persistent live region, so the wait and the answer are announced to a screen reader in turn.
const announcement = computed(() => {
  if (asking.value) return runMode.value === 'replay' ? t('lb05.progress.replaying') : t('lb05.ask.asking')
  return phase.value === 'done' && answer.value ? t('lb05.answer.done') : ''
})

// Another question is still being answered: the one case of a refusal that is not about the day's allowance.
const lastQuestionRunning = computed(() => problem.value?.code === 'question_running')
const shownProblem = computed(() => (problem.value && problem.value.kind !== 'verification' && !lastQuestionRunning.value ? problem.value : undefined))

// The last question the visitor asked, so "try again" after a failed check or a busy refusal asks it again.
const lastRequest = ref<AskRequest>()

/**
 * Scrolls a part of the board into view if it is below the fold, since a tall composer can push what a
 * question produces out of sight. It scrolls and nothing else: focus stays where the visitor put it,
 * and a visitor who prefers reduced motion gets no animation.
 */
async function bringIntoView(id: string): Promise<void> {
  await nextTick()
  const target = document.getElementById(id)
  if (!target || typeof target.scrollIntoView !== 'function') return
  if (target.getBoundingClientRect().top < window.innerHeight * 0.7) return
  const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' })
}

/** Asks a question live and remembers it, for a retry. */
function ask(request: AskRequest): void {
  lastRequest.value = request
  void store.ask(request)
  void bringIntoView(RUN_ID)
}

/** Runs a curated question live. */
function runSample(id: string): void {
  const sample = LB05_SAMPLES.find(candidate => candidate.id === id)
  if (sample) ask({ question: sample.question, source: 'sample', sampleId: sample.id })
}

/** Runs one of the attacks live. */
function runAttack(id: string): void {
  const attack = LB05_ATTACKS.find(candidate => candidate.id === id)
  if (attack) ask({ question: attack.question, source: 'attack', sampleId: attack.id })
}

/** Asks the visitor's own question. */
function askOwn(question: string): void {
  ask({ question, source: 'own' })
}

/** Runs the visitor's own attack. */
function askOwnAttack(question: string): void {
  ask({ question, source: 'own-attack' })
}

/** Replays a recording of a curated question or an attack. */
async function replayRecorded(id: string, source: AskSource): Promise<void> {
  try {
    store.replayRecording(await replay.read(SYSTEM, id), source)
    void bringIntoView(RUN_ID)
  }
  catch (error) {
    store.report(isApiProblem(error) ? error : new ApiProblem(404, 'not_found', 'There is nothing at this address.'))
  }
}

/** Plays the replay on the board again. */
function replayAgain(): void {
  if (replay.recording && asked.value) store.replayRecording(replay.recording, asked.value.source)
}

/** Runs the question or attack that is being replayed live instead. */
function runReplayedLive(): void {
  const request = asked.value
  if (!request?.sampleId) return
  if (request.source === 'attack') runAttack(request.sampleId)
  else runSample(request.sampleId)
}

/** Asks the last question again, after a failed check or a refusal because the one before was still running. */
function askAgain(): void {
  if (lastRequest.value) ask(lastRequest.value)
}

// When the answer is in, it is what the visitor came for. A failure is announced where the run would be.
watch(phase, (next) => {
  if (next === 'done') void bringIntoView('lb05-answer')
})
watch([problem, stoppedWaiting], ([failure, stopped]) => {
  if (failure || stopped) void bringIntoView(RUN_ID)
})

/** Reads the session, and what a board needs from the back end once the session says there is one. */
async function connect(): Promise<void> {
  await session.load()
  if (session.available) {
    void store.loadQuota()
    void store.loadLayer()
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
      {{ t('lb05.intro') }}
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

    <LbSegmented
      v-model="doing"
      class="switch"
      :options="doingOptions"
      :label="t('lb05.modes.label')"
    />

    <!-- Each side keeps what the visitor chose and typed while the other is open. -->
    <KeepAlive>
      <QuestionComposer
        v-if="doing === 'ask'"
        :samples="questions"
        :recorded="recorded"
        :busy="busy"
        :can-run-live="canRunLive"
        :allowance-used-up="allowanceUsedUp"
        @replay="replayRecorded($event, 'sample')"
        @run-sample="runSample"
        @ask="askOwn"
      />
      <SafetyPanel
        v-else
        :attacks="attacks"
        :recorded="recorded"
        :busy="busy"
        :can-run-live="canRunLive"
        :allowance-used-up="allowanceUsedUp"
        :limits="limits"
        :verdicts="verdicts"
        :no-query="noQuery"
        :brief="brief"
        @replay="replayRecorded($event, 'attack')"
        @run="runAttack"
        @ask="askOwnAttack"
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

      <AskNotice
        v-if="lastQuestionRunning"
        kind="busy"
        retryable
        @retry="askAgain"
      />

      <AskNotice
        v-if="stoppedWaiting"
        kind="stopped"
      />

      <BoardReplayBanner
        v-if="replaying && replay.recording"
        :recording="replay.recording"
        :playing="replay.playing"
        :can-run-live="canRunLive"
        @again="replayAgain"
        @live="runReplayedLive"
      />

      <AskProgress
        v-if="asking"
        :started-at="askedAt"
        :total-seconds="limits.question_deadline_seconds"
        :replaying="runMode === 'replay'"
        @stop="store.stopWaiting"
      />

      <AnswerView
        v-if="answer && phase === 'done'"
        :answer="answer"
        :asked="asked"
        :steps="steps"
        :step-labels="stepLabels"
        :steps-blind="stepsBlind"
        :trace-lost="traceLost"
        :limits="limits"
        :brief="brief"
      />
    </div>

    <SemanticBrowser
      v-if="!brief"
      :layer="layer"
      :status="layerStatus"
      @retry="store.loadLayer"
    />

    <template #aside>
      <BoardLimitsPanel
        :limits="system.limits"
        :quota="quota"
        :quota-label="t('lb05.quotaLabel')"
        :brief="brief"
        :now="now"
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

/* The switch is a row of buttons, not a bar across the column. */
.switch {
  justify-self: start;
}

.run {
  display: grid;
  gap: 16px;
  min-width: 0;
  /* Leave room for the site's sticky toolbar when a question's results are scrolled into view. */
  scroll-margin-top: 72px;
}
</style>
