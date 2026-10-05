<script setup lang="ts">
// LB-06's evaluation board: the Incident Commander. A visitor breaks a simulated online shop (a
// curated incident first, or a fault of their own after a quick check that they are a person), watches
// the dashboards of its six services turn, follows a team of agents as they read the shop through
// read-only tools and rank what might be wrong, and approves or rejects the fix the commander
// proposes. Nothing in the simulation changes without that click, and the incident closes only when
// the SLO has recovered, measured by code. A curated incident with a recording replays it for free,
// labelled as a replay. The page follows a live incident over a WebSocket and falls back to polling
// the log; incidents, their logs and their postmortems are deleted after 24 hours.
import { LB06_LIMITS } from '@lb/contracts'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { findSystemIn, isLocaleCode } from '#shared/data/datasheets'
import type { Lb06SampleId } from '#shared/data/samples/lb06'
import { ApiProblem, isApiProblem } from '~/board-kit/problem'
import { useReadingStore } from '~/stores/reading'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'
import AgentsPanel from './components/AgentsPanel.vue'
import ApprovalCard from './components/ApprovalCard.vue'
import HypothesesPanel from './components/HypothesesPanel.vue'
import IncidentBar from './components/IncidentBar.vue'
import MyIncident from './components/MyIncident.vue'
import PostmortemPanel from './components/PostmortemPanel.vue'
import ProblemNotice from './components/ProblemNotice.vue'
import ShopDashboard from './components/ShopDashboard.vue'
import SloPanel from './components/SloPanel.vue'
import StartPanel from './components/StartPanel.vue'
import TimelinePanel from './components/TimelinePanel.vue'
import { useLb06Store } from './store'
import './styles.css'

const props = defineProps<{
  /** Builds the address of a run's permalink page in the visitor's language. */
  permalinkFor: (runId: string) => string
  /** The current time in Unix milliseconds, so the reset countdown can be tested. */
  now?: number
}>()

/** The system's number in the catalog and in the recordings' names. */
const SYSTEM = 'lb-06'

const { t, locale } = useI18n()
const session = useSessionStore()
const scope = useScopeStore()
const replay = useReplayStore()
const store = useLb06Store()
const { mode } = storeToRefs(useReadingStore())
const { runMode, busy, problem, quota, incident, pending } = storeToRefs(store)

const code = computed(() => (isLocaleCode(locale.value) ? locale.value : 'en'))
const system = computed(() => findSystemIn(SYSTEM, code.value))
const brief = computed(() => mode.value === 'brief')
const recorded = computed(() => replay.recorded[SYSTEM])
const available = computed(() => session.available)
const canRunLive = computed(() => available.value && (quota.value?.remaining ?? 1) > 0)
// The back end is there but the visitor has used today's incident: the panel says so instead of blaming the site.
const allowanceUsedUp = computed(() => available.value && quota.value !== undefined && quota.value.remaining <= 0)
const unavailable = computed(() => session.loading === 'ready' && !session.available)
// The session's state could not be read at all: the site itself could not be reached.
const disconnected = computed(() => session.loading === 'failed')
const replaying = computed(() => runMode.value === 'replay' && replay.recording !== undefined)
const starting = computed(() => busy.value === 'starting' || busy.value === 'opening')
const following = computed(() => store.runPhase === 'following')
// The permalink exists for a live incident only: a replay's incident expired long ago.
const permalink = computed(() => (runMode.value === 'live' && scope.runId ? props.permalinkFor(scope.runId) : undefined))
const simulationParams = { seconds: LB06_LIMITS.tickMs / 1_000, minutes: LB06_LIMITS.maxWallMs / 60_000 }
// What the visitor last asked of the board, so "try again" after a failed check asks it again.
const lastAsk = ref<() => void>()

/**
 * Scrolls a part of the board into view if it is below the fold, since the start panel can push what
 * an action produces out of sight. It scrolls and nothing else: focus stays where the visitor put it,
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

/** Runs a curated incident live. */
function startSample(id: Lb06SampleId): void {
  lastAsk.value = () => startSample(id)
  void store.start({ from: 'sample', sampleId: id }).then(() => bringIntoView('lb06-incident'))
}

/** Runs an incident of the visitor's own. */
function startOwn(request: Parameters<typeof store.start>[0]): void {
  lastAsk.value = () => startOwn(request)
  void store.start(request).then(() => bringIntoView('lb06-incident'))
}

/** Replays a curated incident's recording. */
async function replaySample(id: Lb06SampleId): Promise<void> {
  try {
    store.replayRecording(await replay.read(SYSTEM, id))
    void bringIntoView('lb06-incident')
  }
  catch (error) {
    store.report(isApiProblem(error) ? error : new ApiProblem(404, 'not_found', 'There is nothing at this address.'))
  }
}

/** Plays the replay on the board again. */
function replayAgain(): void {
  if (!replay.recording) return
  store.replayRecording(replay.recording)
  void bringIntoView('lb06-incident')
}

/** Runs the incident that is being replayed live instead. */
function runReplayedLive(): void {
  if (replay.recording) startSample(replay.recording.sample as Lb06SampleId)
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

// A proposal waiting for the visitor is the one thing on the board that needs an answer: bring it into view.
watch(pending, (proposal, before) => {
  if (proposal && !before && runMode.value === 'live') void bringIntoView('lb06-approval')
})

onMounted(async () => {
  // Stores outlive the page, so a visitor who comes back finds the board empty, not stuck on an old incident.
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
      {{ t('lb06.intro') }}
    </p>
    <p
      v-if="!brief"
      class="lb6-hint"
    >
      {{ t('lb06.simulation', simulationParams) }}
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
      v-if="starting"
      class="lb6-hint"
      role="status"
      data-testid="starting"
    >
      {{ t('lb06.start.startingStatus') }}
    </p>
    <StartPanel
      :recorded="recorded"
      :busy="starting || following"
      :can-run-live="canRunLive"
      :allowance-used-up="allowanceUsedUp"
      :unavailable="unavailable"
      @replay="replaySample"
      @live="startSample"
      @own="startOwn"
    />
    <BoardTurnstileGate @retry="retryCheck" />
    <template #aside>
      <BoardLimitsPanel
        :limits="system.limits"
        :quota="quota"
        :quota-label="t('lb06.quotaLabel')"
        :brief="brief"
        :now="now"
      />
      <MyIncident />
    </template>
    <template
      v-if="incident"
      #wide
    >
      <div
        id="lb06-incident"
        class="stack"
      >
        <IncidentBar :brief="brief" />
        <ApprovalCard :brief="brief" />
        <div class="pair pair--wide">
          <ShopDashboard :brief="brief" />
          <SloPanel :brief="brief" />
        </div>
        <div class="pair">
          <AgentsPanel :brief="brief" />
          <HypothesesPanel :brief="brief" />
        </div>
        <TimelinePanel :brief="brief" />
        <PostmortemPanel :brief="brief" />
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
  gap: 20px;
  /* Leave room for the site's sticky toolbar when the incident is scrolled into view. */
  scroll-margin-top: 72px;
}
.pair {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr));
  gap: 20px;
  align-items: start;
}
.pair--wide {
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr));
}
</style>
