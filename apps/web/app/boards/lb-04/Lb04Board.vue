<script setup lang="ts">
// LB-04's evaluation board, the Contract Radar. A visitor picks one of six synthetic contracts, or sends a
// PDF of their own, and the system reads it against the company's playbook: it extracts the text and where
// every word sits, screens it for instructions aimed at a reviewer, has a model find the clauses that go
// against the playbook and quote them, and then the server checks every quote against the contract's text
// and keeps only the ones that are really there. The board shows the review as it goes, by the state the
// service reports; then the risk radar, the findings with their passages as text, and the contract's PDF
// with the cited characters highlighted. A finding can be turned into a proposed wording, shown as a
// word-by-word redline. A sample with a recording replays it for free, labelled as a replay; a live review
// takes one of the day's three contracts, after a quick check that the visitor is a person.
// The result is always labelled "Not legal advice": it is a reading aid.
import type { Lb04Topic } from '@lb/contracts'
import { LbIcon } from '@lb/icons'
import { storeToRefs } from 'pinia'
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { findSystemIn, isLocaleCode } from '#shared/data/datasheets'

import { ApiProblem, isApiProblem } from '~/board-kit/problem'
import { formatMoment } from '~/board-kit/format'
import { useReadingStore } from '~/stores/reading'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'

import ContractStarter from './components/ContractStarter.vue'
import FindingsList from './components/FindingsList.vue'
import MyContracts from './components/MyContracts.vue'
import PlaybookPanel from './components/PlaybookPanel.vue'
import ReportSummary from './components/ReportSummary.vue'
import ReviewFailure from './components/ReviewFailure.vue'
import ReviewProgress from './components/ReviewProgress.vue'
import RiskRadar from './components/RiskRadar.vue'
import { formatSize } from './file'
import { DEFAULT_LIMITS } from './limits'
import { ownNoticeOf } from './problems'
import { useLb04Store } from './store'
import type { Asked } from './store'
import './styles.css'

// The viewer, and with it pdf.js, is loaded only when a visitor first asks to see the contract's pages.
const ContractViewer = defineAsyncComponent(() => import('./components/ContractViewer.vue'))

const props = defineProps<{
  /** Builds the address of a run's permalink page in the visitor's language. */
  permalinkFor: (runId: string) => string
  /** The current time in Unix milliseconds, so the reset countdown can be tested. */
  now?: number
}>()

/** The system's number in the catalog and in the recordings' names. */
const SYSTEM = 'lb-04'

/** The part of the page that holds what a review produces, which is scrolled into view when one starts. */
const RUN_ID = 'lb04-run'

const { t, locale } = useI18n()
const session = useSessionStore()
const scope = useScopeStore()
const replay = useReplayStore()
const store = useLb04Store()
const { mode: reading } = storeToRefs(useReadingStore())
const { quota, runMode, phase, asked, problem, redlineProblem, contract, failure, pages, pdf, report, redlining, focus, startedAt, stoppedWaiting, mine, playbook, playbookStatus, busy, canRedline } = storeToRefs(store)

const code = computed(() => (isLocaleCode(locale.value) ? locale.value : 'en'))
const system = computed(() => findSystemIn(SYSTEM, code.value))
const brief = computed(() => reading.value === 'brief')

const recorded = computed(() => replay.recorded[SYSTEM])
const available = computed(() => session.available)
const canRunLive = computed(() => available.value && (quota.value?.remaining ?? 1) > 0)
// The back end is there but the visitor has no contract left today: the starter says so instead of blaming the site.
const allowanceUsedUp = computed(() => available.value && quota.value !== undefined && quota.value.remaining <= 0)
const unavailable = computed(() => session.loading === 'ready' && !session.available)
// The session's state could not be read at all: the site itself could not be reached.
const disconnected = computed(() => session.loading === 'failed')
const replaying = computed(() => runMode.value === 'replay' && replay.recording !== undefined)
const live = computed(() => runMode.value === 'live')
const maxSize = computed(() => formatSize(DEFAULT_LIMITS.maxFileBytes, locale.value))

// The review is on its way: the request is going, or the service is working on the contract.
const inProgress = computed(() => phase.value === 'starting' || (phase.value === 'following' && contract.value !== undefined && contract.value.state !== 'done' && contract.value.state !== 'failed'))
const showProgress = computed(() => inProgress.value && (contract.value !== undefined || live.value))
const failed = computed(() => contract.value?.state === 'failed' && failure.value !== undefined)

// The permalink exists for a live review only: a replay's run expired long ago.
const permalink = computed(() => (live.value && scope.runId ? props.permalinkFor(scope.runId) : undefined))

// What the visitor narrowed the findings to, and which finding the viewer shows.
const topic = ref<Lb04Topic>()
const selectedId = ref<string>()
const viewerOpen = ref(false)
const viewerShown = computed(() => (viewerOpen.value || focus.value !== undefined) && pdf.value !== undefined && pages.value !== undefined && report.value !== undefined)
const viewerWaiting = computed(() => (viewerOpen.value || focus.value !== undefined) && !viewerShown.value && report.value !== undefined)

// A persistent live region, so the review's progress and its end are announced to a screen reader in turn.
const announcement = computed(() => {
  if (phase.value === 'starting') return t('lb04.live.starting')
  const state = contract.value?.state
  if (state === 'failed') return t('lb04.live.failed')
  if (state === 'done' && report.value) return t('lb04.live.done', { count: report.value.findings.length })
  return state ? t(`lb04.live.${state}`) : ''
})

// A refusal the board words itself, or the kit's notice for the kind of failure.
const own = computed(() => (problem.value ? ownNoticeOf(problem.value) : undefined))
const shownProblem = computed(() => (problem.value && problem.value.kind !== 'verification' && own.value === undefined ? problem.value : undefined))
const redlineOwn = computed(() => (redlineProblem.value ? ownNoticeOf(redlineProblem.value) : undefined))
const shownRedlineProblem = computed(() => (redlineProblem.value && redlineProblem.value.kind !== 'verification' && redlineOwn.value === undefined ? redlineProblem.value : undefined))
// The review took longer than the board waits: the service goes on, and the contract is in the visitor's list.
const tookLong = computed(() => problem.value?.code === 'review_timeout')

// What the visitor last asked for, so "try again" after a failed check asks it again.
let lastAsk: { kind: 'sample', id: string } | { kind: 'file', file: File } | undefined

/**
 * Scrolls a part of the board into view if it is below the fold, since a tall starter can push what a
 * review produces out of sight. It scrolls and nothing else: focus stays where the visitor put it, and a
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

/** Forgets what the visitor looked at in the last report. */
function clearView(): void {
  topic.value = undefined
  selectedId.value = undefined
  viewerOpen.value = false
}

/** Reviews a curated sample live. */
function runSample(id: string): void {
  lastAsk = { kind: 'sample', id }
  clearView()
  void store.reviewSample(id)
}

/** Reviews a file the visitor chose. */
function runFile(file: File): void {
  lastAsk = { kind: 'file', file }
  clearView()
  void store.reviewFile(file, file.name)
}

/** Replays a recording of a curated sample. */
async function replayRecorded(id: string): Promise<void> {
  try {
    clearView()
    store.replayRecording(await replay.read(SYSTEM, id), { kind: 'sample', sampleId: id })
    void bringIntoView(RUN_ID)
  }
  catch (error) {
    store.showProblem(isApiProblem(error) ? error : new ApiProblem(404, 'not_found', 'There is nothing at this address.'))
  }
}

/** Plays the replay on the board again. */
function replayAgain(): void {
  const request: Asked | undefined = asked.value
  if (replay.recording && request) {
    clearView()
    store.replayRecording(replay.recording, request)
  }
}

/** Reviews the sample that is being replayed live instead. */
function runReplayedLive(): void {
  const request = asked.value
  if (request?.kind === 'sample') runSample(request.sampleId)
}

/** Asks again what the visitor last asked, after a failed check. */
function askAgain(): void {
  if (lastAsk?.kind === 'sample') runSample(lastAsk.id)
  else if (lastAsk?.kind === 'file') runFile(lastAsk.file)
}

/** Takes up one of the visitor's own contracts. */
function openMine(id: string): void {
  clearView()
  void store.openContract(id)
  void bringIntoView(RUN_ID)
}

/** Shows a finding's passage in the viewer. */
function showFinding(id: string): void {
  selectedId.value = id
  viewerOpen.value = true
  store.show(id)
}

/** Opens the viewer on the contract's first page, without a finding. */
function openViewer(): void {
  viewerOpen.value = true
  void store.loadPdf()
}

/** Reads the session, and what a board needs from the back end once the session says there is one. */
async function connect(): Promise<void> {
  await session.load()
  if (session.available) {
    void store.loadLimits()
    void store.loadMine()
  }
}

// A live review is shown once it has been sent: before that the check that the visitor is a person may
// still open and close above it, and the page would be scrolled to where the starter was a moment ago.
watch(startedAt, (since) => {
  if (since !== undefined) void bringIntoView(RUN_ID)
})
// When the report is in, it is what the visitor came for. A failure is announced where the review would be.
watch(report, (next) => {
  if (next) void bringIntoView('lb04-report')
})
watch([problem, stoppedWaiting, failed], ([trouble, stopped, over]) => {
  if (trouble || stopped || over) void bringIntoView(RUN_ID)
})

onMounted(async () => {
  // Stores outlive the page, so a visitor who comes back finds the board empty, not stuck on an old review.
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
      {{ t('lb04.intro') }}
    </p>
    <p class="label-row">
      <span class="lb4-chip lb4-chip--board">{{ t('lb04.notLegalAdvice') }}</span>
      <span class="lb4-hint">{{ t('lb04.notLegalAdviceText') }}</span>
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

    <ContractStarter
      :recorded="recorded"
      :busy="busy"
      :can-run-live="canRunLive"
      :allowance-used-up="allowanceUsedUp"
      @replay="replayRecorded"
      @run-sample="runSample"
      @run-file="runFile"
    />

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
        v-if="shownProblem && !tookLong"
        :kind="shownProblem.kind"
        :resets-at="shownProblem.resetsAt ?? session.state?.resetsAt"
        :detail="shownProblem.kind === 'rejected' ? shownProblem.message : undefined"
      />

      <div
        v-if="own"
        class="own-notice"
        role="alert"
        data-testid="own-notice"
        :data-notice="own"
      >
        <LbIcon
          name="warning"
          :size="20"
        />
        <div>
          <p class="notice-title">
            {{ t(`lb04.notices.${own}.title`) }}
          </p>
          <p>{{ t(`lb04.notices.${own}.text`, { size: maxSize, minutes: DEFAULT_LIMITS.keptMinutes }) }}</p>
        </div>
      </div>

      <div
        v-if="tookLong"
        class="own-notice"
        role="status"
        data-testid="took-long"
      >
        <LbIcon
          name="clock"
          :size="20"
        />
        <div>
          <p class="notice-title">
            {{ t('lb04.notices.long.title') }}
          </p>
          <p>{{ t('lb04.notices.long.text') }}</p>
        </div>
      </div>

      <div
        v-if="stoppedWaiting"
        class="own-notice"
        role="status"
        data-testid="stopped"
      >
        <LbIcon
          name="info"
          :size="20"
        />
        <div>
          <p class="notice-title">
            {{ t('lb04.notices.stopped.title') }}
          </p>
          <p>{{ t('lb04.notices.stopped.text') }}</p>
        </div>
      </div>

      <BoardReplayBanner
        v-if="replaying && replay.recording"
        :recording="replay.recording"
        :playing="replay.playing"
        :can-run-live="canRunLive"
        @again="replayAgain"
        @live="runReplayedLive"
      />

      <header
        v-if="contract"
        class="contract"
        data-testid="contract"
      >
        <LbIcon
          name="contract"
          :size="20"
        />
        <div class="what">
          <p class="name">
            {{ contract.title }}
          </p>
          <p class="lb4-hint lb4-nums">
            <template v-if="contract.pages !== null">
              {{ t('lb04.contract.pages', { count: contract.pages }) }}
              ·
            </template>
            <template v-if="live">
              {{ t('lb04.contract.until', { time: formatMoment(contract.expiresAt, locale) }) }}
            </template>
          </p>
        </div>
        <span class="lb4-chip">{{ t('lb04.notLegalAdvice') }}</span>
        <button
          v-if="live && !inProgress"
          type="button"
          class="lb4-button lb4-button--quiet"
          data-testid="delete-contract"
          @click="store.deleteContract()"
        >
          {{ t('lb04.contract.delete') }}
        </button>
      </header>

      <ReviewProgress
        v-if="showProgress"
        :state="contract?.state ?? 'queued'"
        :pages="contract?.pages ?? null"
        :started-at="live ? startedAt : undefined"
        :replaying="runMode === 'replay'"
        @stop="store.stopWaiting"
      />

      <ReviewFailure
        v-if="failed && failure"
        :code="failure.code"
        :replaying="runMode === 'replay'"
        :limit="DEFAULT_LIMITS.maxPages"
      />

      <div
        v-if="report && contract"
        id="lb04-report"
        class="report"
        data-testid="report"
      >
        <ReportSummary
          :report="report"
          :brief="brief"
        />
        <RiskRadar
          :scores="report.radar"
          :selected="topic"
          @select="topic = $event"
        />

        <BoardNotice
          v-if="shownRedlineProblem"
          :kind="shownRedlineProblem.kind"
          :resets-at="shownRedlineProblem.resetsAt"
        />
        <div
          v-if="redlineOwn"
          class="own-notice"
          role="alert"
          data-testid="own-notice"
          :data-notice="redlineOwn"
        >
          <LbIcon
            name="warning"
            :size="20"
          />
          <div>
            <p class="notice-title">
              {{ t(`lb04.notices.${redlineOwn}.title`) }}
            </p>
            <p>{{ t(`lb04.notices.${redlineOwn}.text`, { size: maxSize, minutes: DEFAULT_LIMITS.keptMinutes }) }}</p>
          </div>
        </div>

        <p
          v-if="live"
          class="lb4-hint lb4-nums"
          data-testid="redlines-left"
        >
          {{ t('lb04.findings.redlinesLeft', { left: contract.redlinesLeft, total: DEFAULT_LIMITS.redlines }) }}
        </p>

        <FindingsList
          :findings="report.findings"
          :redlines="report.redlines"
          :topic="topic"
          :selected-id="selectedId"
          :can-redline="canRedline"
          :redlining="redlining"
          :live="live"
          :brief="brief"
          @show="showFinding"
          @redline="store.makeRedline"
          @clear="topic = undefined"
        />

        <div
          v-if="!viewerShown && !viewerWaiting"
          class="lb4-row"
        >
          <button
            type="button"
            class="lb4-button"
            data-testid="open-viewer"
            @click="openViewer"
          >
            <LbIcon
              name="contract"
              :size="16"
            />
            {{ t('lb04.viewer.open') }}
          </button>
          <span class="lb4-hint">{{ t('lb04.viewer.openNote') }}</span>
        </div>
        <p
          v-if="viewerWaiting"
          class="lb4-hint"
          role="status"
        >
          {{ store.pdfStatus === 'failed' ? t('lb04.viewer.unavailable') : t('lb04.viewer.fetching') }}
        </p>
        <ContractViewer
          v-if="viewerShown && pdf && pages && report"
          :pdf="pdf"
          :pages="pages"
          :findings="report.findings"
          :focus="focus"
          :selected-id="selectedId"
          @select="showFinding"
        />
      </div>
    </div>

    <MyContracts
      v-if="live || runMode === 'idle'"
      :contracts="mine"
      :active-id="contract?.id"
      :busy="busy"
      @open="openMine"
    />

    <PlaybookPanel
      v-if="!brief"
      :playbook="playbook"
      :status="playbookStatus"
      @open="store.loadPlaybook"
      @retry="store.loadPlaybook"
    />

    <template #aside>
      <BoardLimitsPanel
        :limits="system.limits"
        :quota="quota"
        :quota-label="t('lb04.quotaLabel')"
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

.label-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

.run {
  display: grid;
  gap: 16px;
  min-width: 0;
  /* Leave room for the site's sticky toolbar when a review's results are scrolled into view. */
  scroll-margin-top: 72px;
}

.report {
  display: grid;
  gap: 20px;
  min-width: 0;
  scroll-margin-top: 72px;
}

.contract {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 10px 14px;
  background: var(--lb-sheet);
  border: 1px solid var(--lb-rule);
}

.what {
  flex: 1 1 14rem;
  min-width: 0;
}

.name {
  font-weight: 700;
  overflow-wrap: anywhere;
}

.own-notice {
  display: flex;
  gap: 12px;
  padding: 12px 14px;
  background: var(--lb-shade);
  border: 1.5px solid var(--lb-ink);
}

.notice-title {
  font-weight: 700;
}
</style>
