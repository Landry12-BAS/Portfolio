<script setup lang="ts">
// LB-03's evaluation board, the Invoice Reader. A visitor chooses a document (a curated sample first, or
// their own PDF or photo after a quick check that they are a person), and watches it being read: the stage
// it is in, honestly, with no made-up percentage. Then the reading is theirs to inspect: the page with the
// box of every field the reader found lit up and how sure it is (in words and a percentage, never colour
// alone), a table of the fields they can correct (every check runs again), the validation checklist, the
// duplicate verdict, the journal entry the document makes, and the export. A document that fails a check is
// shown with the check that failed and is never silently fixed; one the injection check stops shows why.
// A sample with a recording replays it for free, labelled as a replay. The page polls and never streams,
// and the visitor's files and what was read from them are deleted after an hour.
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { findSystemIn, isLocaleCode } from '#shared/data/datasheets'
import { LB03_SAMPLES } from '#shared/data/samples/lb03'

import { ApiProblem, isApiProblem } from '~/board-kit/problem'
import type { PickerSample } from '~/board-kit/samples'
import { useReadingStore } from '~/stores/reading'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'

import ChecksPanel from './components/ChecksPanel.vue'
import DocumentComposer from './components/DocumentComposer.vue'
import DocumentShelf from './components/DocumentShelf.vue'
import DocumentViewer from './components/DocumentViewer.vue'
import DuplicatePanel from './components/DuplicatePanel.vue'
import ExportPanel from './components/ExportPanel.vue'
import FieldsTable from './components/FieldsTable.vue'
import JournalPanel from './components/JournalPanel.vue'
import ReadFailure from './components/ReadFailure.vue'
import ReadProgress from './components/ReadProgress.vue'
import ReadingCounters from './components/ReadingCounters.vue'
import StepsPanel from './components/StepsPanel.vue'
import UploadNotice from './components/UploadNotice.vue'
import { tally } from './checks'
import { fieldLabel } from './fields'
import { DOCUMENT_GIVE_UP_SECONDS } from './progress'
import { correctionRefusal, uploadRefusal } from './refusals'
import { useLb03Store } from './store'
import { pageUrl, samplePageUrl } from './urls'

const props = defineProps<{
  /** Builds the address of a run's permalink page in the visitor's language. */
  permalinkFor: (runId: string) => string
  /** The current time in Unix milliseconds, so the reset countdown and the clock can be tested. */
  now?: number
}>()

/** The system's number in the catalog and in the recordings' names. */
const SYSTEM = 'lb-03'

const { t, locale } = useI18n()
const session = useSessionStore()
const scope = useScopeStore()
const replay = useReplayStore()
const store = useLb03Store()
const { mode } = storeToRefs(useReadingStore())
const { onBoard, documents, documentsStatus, quota, allowance, runMode, phase, problem, startedAt, selectedPath, page, pages, replaySample, correcting, correctionProblem, deleting } = storeToRefs(store)

const code = computed(() => (isLocaleCode(locale.value) ? locale.value : 'en'))
const system = computed(() => findSystemIn(SYSTEM, code.value))
const brief = computed(() => mode.value === 'brief')

const samples = computed<PickerSample[]>(() => LB03_SAMPLES.map(sample => ({
  id: sample.id,
  title: t(`lb03.samples.${sample.id}.title`),
  note: t(`lb03.samples.${sample.id}.note`),
  language: 'en',
  excerpt: `${sample.vendor}, ${sample.number}`,
})))

const recorded = computed(() => replay.recorded[SYSTEM])
const available = computed(() => session.available)
const canRunLive = computed(() => available.value && (allowance.value?.remaining ?? 1) > 0 && store.canRead)
// The back end is there but the visitor has no document left today: the composer says so instead of blaming the site.
const allowanceUsedUp = computed(() => available.value && allowance.value !== undefined && allowance.value.remaining <= 0)
const readerOff = computed(() => available.value && !store.canRead)
const unavailable = computed(() => session.loading === 'ready' && !session.available)
// The session's state could not be read at all: the site itself could not be reached.
const disconnected = computed(() => session.loading === 'failed')
const replaying = computed(() => runMode.value === 'replay' && replay.recording !== undefined)

// A file is being sent, or a live document is being read: the composer waits.
const busy = computed(() => phase.value === 'sending' || (runMode.value === 'live' && phase.value === 'reading'))
const showProgress = computed(() => phase.value === 'sending' || (phase.value === 'reading' && !store.finished))
const failed = computed(() => onBoard.value?.state === 'failed')
const showReading = computed(() => store.finished)
// A failed document has no fields, but a replay of one still has the sample's page to show, so the page the hostile text is on can be seen.
const showViewer = computed(() => store.ready || (failed.value && runMode.value === 'replay' && replaySample.value !== undefined))
const maxPages = computed(() => quota.value?.limits.max_pages ?? 5)

// The page's picture: the service's own for a live document, the sample's static one for a replay.
const pictureUrl = computed(() => {
  const current = onBoard.value
  if (current === undefined) return undefined
  if (runMode.value === 'replay') return replaySample.value === undefined ? undefined : samplePageUrl(replaySample.value, page.value)
  return pageUrl(current.id, page.value)
})

// The permalink exists for a live run only: a replay's run expired long ago.
const permalink = computed(() => (runMode.value === 'live' && scope.runId ? props.permalinkFor(scope.runId) : undefined))
const compared = computed(() => {
  const value = onBoard.value?.steps.find(step => step.name === 'check duplicates')?.detail.compared
  return typeof value === 'number' ? value : undefined
})
const duplicateCheck = computed(() => onBoard.value?.checks?.find(check => check.id === 'not_duplicate'))
const refusal = computed(() => (problem.value ? uploadRefusal(problem.value) : undefined))
const editRefusal = computed(() => (correctionProblem.value ? correctionRefusal(correctionProblem.value) : undefined))

// What the last correction did, for the live region above the table.
const fieldsStatus = ref('')
// What the visitor last asked to run, so "try again" after a failed check runs it again.
const lastRun = ref<() => void>()

watch(() => onBoard.value?.id, () => {
  fieldsStatus.value = ''
})

/**
 * Scrolls a part of the board into view if it is below the fold, since the composer can push what a run
 * produces out of sight. It scrolls and nothing else: focus stays where the visitor put it, and a visitor
 * who prefers reduced motion gets no animation.
 */
async function bringIntoView(id: string): Promise<void> {
  await nextTick()
  const target = window.document.getElementById(id)
  if (!target || typeof target.scrollIntoView !== 'function') return
  if (target.getBoundingClientRect().top < window.innerHeight * 0.7) return
  const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' })
}

/** Shows the run's progress when it starts. */
function revealRun(): Promise<void> {
  return bringIntoView('lb03-progress')
}

/** Uploads a file the visitor chose, and remembers it for a retry. */
function uploadOwn(file: File): void {
  lastRun.value = () => void store.upload(file).then(revealRun)
  lastRun.value()
}

/** Runs a curated sample live: its file is uploaded as if the visitor had chosen it. */
function runSample(id: string): void {
  const sample = LB03_SAMPLES.find(candidate => candidate.id === id)
  if (sample === undefined) return
  lastRun.value = () => void store.uploadSample(sample).then(revealRun)
  lastRun.value()
}

/** Replays a sample's recording. */
async function playRecording(id: string): Promise<void> {
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

/** Tries the last upload again after a failed check. */
function retryCheck(): void {
  lastRun.value?.()
}

/** Corrects a field, and says what that did to the checks. */
async function correct(path: string, value: string): Promise<void> {
  const done = await store.correct(path, value)
  if (!done) {
    fieldsStatus.value = ''
    return
  }
  const counts = onBoard.value?.checks ? tally(onBoard.value.checks) : undefined
  fieldsStatus.value = t('lb03.fields.saved', { field: fieldLabel(path, t), failed: counts === undefined ? 0 : counts.errors + counts.warnings })
}

// When the document has been read, the reading is what the visitor came for.
watch(() => store.finished, (done) => {
  if (done) void bringIntoView('lb03-reading')
})

/** Reads the session, and what a board needs from the back end once the session says there is one. */
async function connect(): Promise<void> {
  await session.load()
  if (session.available) {
    void store.loadQuota()
    void store.loadDocuments()
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
      {{ t('lb03.intro') }}
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

    <UploadNotice
      v-if="refusal"
      :kind="refusal"
    />
    <BoardNotice
      v-else-if="problem && problem.kind !== 'verification'"
      :kind="problem.kind"
      :resets-at="problem.resetsAt ?? session.state?.resetsAt"
      :detail="problem.kind === 'rejected' ? problem.message : undefined"
    />

    <DocumentComposer
      :catalog="LB03_SAMPLES"
      :samples="samples"
      :recorded="recorded"
      :busy="busy"
      :can-run-live="canRunLive"
      :allowance-used-up="allowanceUsedUp"
      :reader-off="readerOff"
      :max-pages="maxPages"
      @replay="playRecording"
      @run-sample="runSample"
      @upload="uploadOwn"
    />

    <BoardTurnstileGate @retry="retryCheck" />

    <ReadProgress
      v-if="showProgress"
      id="lb03-progress"
      :document="onBoard"
      :started-at="startedAt"
      :limit-seconds="DOCUMENT_GIVE_UP_SECONDS"
      :replaying="runMode === 'replay'"
      :now="now"
    />

    <ReadFailure
      v-if="failed && onBoard"
      :document="onBoard"
      :replaying="runMode === 'replay'"
    />

    <template #aside>
      <BoardLimitsPanel
        :limits="system.limits"
        :quota="allowance"
        :quota-label="t('lb03.quotaLabel')"
        :brief="brief"
        :now="now"
      />
      <ReadingCounters
        :document="onBoard"
        :quota="quota"
        :brief="brief"
        :replaying="runMode === 'replay'"
      />
      <DocumentShelf
        :documents="documents"
        :status="documentsStatus"
        :current-id="runMode === 'live' ? onBoard?.id : undefined"
        :busy="busy"
        :deleting="deleting"
        @open="store.open"
        @remove="store.remove"
      />
    </template>

    <template
      v-if="showReading && onBoard"
      #wide
    >
      <div
        id="lb03-reading"
        class="reading"
      >
        <div
          v-if="showViewer && pictureUrl"
          class="split"
        >
          <DocumentViewer
            class="viewer"
            :picture-url="pictureUrl"
            :page="page"
            :pages="pages"
            :fields="onBoard.fields"
            :selected="selectedPath"
            :label="onBoard.label"
            @page="store.showPage"
            @select="store.select"
          />
          <FieldsTable
            v-if="onBoard.fields"
            :fields="onBoard.fields"
            :selected="selectedPath"
            :editable="runMode === 'live'"
            :busy="correcting"
            :problem="editRefusal"
            :status="fieldsStatus"
            :checks="onBoard.checks ?? []"
            :corrections="onBoard.corrections"
            @select="store.select"
            @correct="correct"
          />
        </div>

        <div
          v-if="onBoard.state === 'ready' && onBoard.checks && onBoard.fields"
          class="panels"
        >
          <ChecksPanel
            :checks="onBoard.checks"
            :fields="onBoard.fields"
            :selected="selectedPath"
            @select="store.select"
          />
          <div class="stack">
            <DuplicatePanel
              :duplicate="onBoard.duplicate"
              :check="duplicateCheck"
              :compared="compared"
              :known="documents"
            />
            <JournalPanel
              :journal="onBoard.journal"
              :status="onBoard.journal_status"
            />
            <ExportPanel
              :document-id="onBoard.id"
              :can-export="onBoard.can_export"
              :journal-made="onBoard.journal !== null"
              :live="runMode === 'live'"
            />
          </div>
        </div>

        <StepsPanel
          v-if="!brief"
          :document="onBoard"
          :chain="system.chain"
        />
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

#lb03-progress,
#lb03-reading {
  /* Leave room for the site's sticky toolbar when a run's results are scrolled into view. */
  scroll-margin-top: 72px;
}

.reading {
  display: grid;
  gap: 24px;
  min-width: 0;
}

/* The page on the left and its fields on the right; the page stays in view while the fields are read. */
.split {
  display: grid;
  grid-template-columns: minmax(260px, 5fr) minmax(0, 7fr);
  gap: 20px;
  align-items: start;
}

.viewer {
  position: sticky;
  top: 72px;
}

.panels {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}

.stack {
  display: grid;
  gap: 24px;
  min-width: 0;
}

@media (max-width: 900px) {
  .split,
  .panels {
    grid-template-columns: minmax(0, 1fr);
  }

  .viewer {
    position: static;
  }
}
</style>
