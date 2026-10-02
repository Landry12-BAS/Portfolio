<script setup lang="ts">
// <ContractStarter>: where a visitor chooses the contract to review. The board opens on six curated samples,
// each a synthetic contract made for the demo: one with problems planted in it, a fair one in which a
// reviewer that reports anything is wrong, one at the 30-page limit, one that talks to its reviewer, and
// two the system must refuse (a 31-page file and a scan). A sample with a recording replays it for nothing,
// labelled as a replay; one without says so and offers the live review, which takes one of the visitor's
// three contracts for the day. The second way in is the visitor's own PDF, checked here against the limits
// before it is sent, with a plain account of what happens to it: kept an hour, then deleted.
import type { PickerSample } from '~/board-kit/samples'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { LB04_SAMPLES } from '#shared/data/samples/lb04'

import { fileProblemOf, formatSize } from '../file'
import type { FileProblem } from '../file'
import { DEFAULT_LIMITS } from '../limits'

const props = defineProps<{
  /** The IDs of the samples that have a recording, or undefined while that is not known yet. */
  recorded: readonly string[] | undefined
  /** A live review is going: another cannot start until it is over, but a replay may. */
  busy: boolean
  /** Whether a live review can be started: this deployment has a back end and the visitor has a contract left today. */
  canRunLive: boolean
  /** The back end is there but the visitor has no contract left today. */
  allowanceUsedUp: boolean
}>()

const emit = defineEmits<{ replay: [id: string], runSample: [id: string], runFile: [file: File] }>()

const { t, locale } = useI18n()

/** Where the contract comes from. */
type Source = 'samples' | 'own'

const source = ref<Source>('samples')
const sourceOptions = computed(() => [
  { value: 'samples' as const, label: t('lb04.start.samples') },
  { value: 'own' as const, label: t('lb04.start.own') },
])

const selected = ref<string | undefined>(LB04_SAMPLES[0].id)
const chosen = computed(() => LB04_SAMPLES.find(sample => sample.id === selected.value))
const pickerSamples = computed<PickerSample[]>(() => LB04_SAMPLES.map(sample => ({
  id: sample.id,
  title: t(`lb04.sample.${sample.id}.title`),
  note: t(`lb04.sample.${sample.id}.note`),
  language: 'en',
  excerpt: factsOf(sample),
})))
const hasRecording = computed(() => chosen.value !== undefined && props.recorded?.includes(chosen.value.id) === true)
const recordingKnown = computed(() => props.recorded !== undefined)

/** Writes what a sample is in numbers: its pages, and what a correct review of it finds. */
function factsOf(sample: (typeof LB04_SAMPLES)[number]): string {
  if (sample.outcome === 'refused') return t('lb04.samples.facts.refused', { pages: sample.pages })
  if (sample.planted === 0 && sample.absent === 0) return t('lb04.samples.facts.clean', { pages: sample.pages })
  return t('lb04.samples.facts.report', { pages: sample.pages, planted: sample.planted, absent: sample.absent })
}

// ---- The visitor's own PDF ----

const file = ref<File>()
const fileProblem = ref<FileProblem>()
const maxSize = computed(() => formatSize(DEFAULT_LIMITS.maxFileBytes, locale.value))

/** Reads a chosen file's first bytes and says what is wrong with it, before anything is sent. */
async function onPick(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const picked = input.files?.[0]
  file.value = picked
  fileProblem.value = undefined
  if (!picked) return
  const head = new Uint8Array(await picked.slice(0, 8).arrayBuffer())
  fileProblem.value = fileProblemOf(picked.size, head)
}

// A visitor who goes back to the samples and returns finds the file they chose still there.
watch(source, () => {
  fileProblem.value = file.value ? fileProblem.value : undefined
})

const canSubmitFile = computed(() => file.value !== undefined && fileProblem.value === undefined && props.canRunLive && !props.busy)

/** Sends the chosen file up to be reviewed. */
function submitFile(): void {
  if (file.value && canSubmitFile.value) emit('runFile', file.value)
}

/** Why a review cannot be started live right now, in words, or nothing when it can. */
const liveBlock = computed(() => {
  if (props.busy) return t('lb04.start.busy')
  if (props.allowanceUsedUp) return t('lb04.start.usedUp')
  if (!props.canRunLive) return t('lb04.start.noLive')
  return undefined
})
</script>

<template>
  <section
    class="lb4-section"
    aria-labelledby="lb4-start-heading"
    data-testid="starter"
  >
    <h2 id="lb4-start-heading">
      {{ t('lb04.start.title') }}
    </h2>

    <LbSegmented
      v-model="source"
      :options="sourceOptions"
      :label="t('lb04.start.sourceLabel')"
      class="switch"
    />

    <template v-if="source === 'samples'">
      <BoardSamplePicker
        v-model="selected"
        :samples="pickerSamples"
        :recorded="recorded"
        :legend="t('lb04.samples.legend')"
      />

      <div
        v-if="chosen"
        class="lb4-panel detail"
        data-testid="sample-detail"
      >
        <h3>{{ t('lb04.samples.about') }}</h3>
        <p class="strong">
          {{ t(`lb04.sample.${chosen.id}.title`) }}
        </p>
        <p>{{ t(`lb04.sample.${chosen.id}.note`) }}</p>
        <p class="lb4-hint">
          {{ factsOf(chosen) }}
        </p>
        <p class="lb4-hint">
          {{ hasRecording ? t('lb04.samples.recorded') : recordingKnown ? t('lb04.samples.noRecording') : '' }}
          {{ t('lb04.samples.liveCost', { contracts: DEFAULT_LIMITS.contracts }) }}
        </p>
        <div class="lb4-row">
          <button
            v-if="hasRecording"
            type="button"
            class="lb4-button lb4-button--primary"
            data-testid="replay-sample"
            @click="emit('replay', chosen.id)"
          >
            {{ t('lb04.samples.replay') }}
          </button>
          <button
            type="button"
            class="lb4-button"
            :class="{ 'lb4-button--primary': !hasRecording }"
            :disabled="!canRunLive || busy"
            data-testid="run-sample"
            @click="emit('runSample', chosen.id)"
          >
            {{ hasRecording ? t('lb04.samples.reviewInstead') : t('lb04.samples.review') }}
          </button>
        </div>
        <p
          v-if="liveBlock"
          class="lb4-hint"
          role="status"
        >
          {{ liveBlock }}
        </p>
      </div>
    </template>

    <div
      v-else
      class="lb4-panel own"
      data-testid="upload"
    >
      <h3>{{ t('lb04.upload.title') }}</h3>
      <label
        for="lb4-file"
        class="label"
      >{{ t('lb04.upload.label') }}</label>
      <input
        id="lb4-file"
        type="file"
        accept="application/pdf,.pdf"
        class="control"
        :aria-describedby="fileProblem ? 'lb4-file-hint lb4-file-problem' : 'lb4-file-hint'"
        :aria-invalid="fileProblem !== undefined"
        data-testid="upload-input"
        @change="onPick"
      >
      <p
        id="lb4-file-hint"
        class="lb4-hint"
      >
        {{ t('lb04.upload.hint', { pages: DEFAULT_LIMITS.maxPages, size: maxSize, minutes: DEFAULT_LIMITS.keptMinutes }) }}
      </p>
      <p
        v-if="file && !fileProblem"
        class="chosen lb4-nums"
      >
        {{ t('lb04.upload.chosen', { name: file.name, size: formatSize(file.size, locale) }) }}
      </p>
      <p
        v-if="fileProblem"
        id="lb4-file-problem"
        class="problem"
        role="alert"
      >
        {{ t(`lb04.upload.problems.${fileProblem}`, { size: maxSize }) }}
      </p>
      <p class="lb4-hint">
        {{ t('lb04.upload.privacy') }}
      </p>
      <p class="lb4-hint">
        {{ t('lb04.upload.cost', { contracts: DEFAULT_LIMITS.contracts }) }}
      </p>
      <div class="lb4-row">
        <button
          type="button"
          class="lb4-button lb4-button--primary"
          :disabled="!canSubmitFile"
          data-testid="run-file"
          @click="submitFile"
        >
          {{ t('lb04.upload.submit') }}
        </button>
      </div>
      <p
        v-if="liveBlock"
        class="lb4-hint"
        role="status"
      >
        {{ liveBlock }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.switch {
  justify-self: start;
}

.detail,
.own {
  gap: 10px;
}

.strong {
  font-weight: 700;
}

.label {
  font-size: 13px;
  font-weight: 700;
}

.control {
  width: 100%;
  min-width: 0;
  padding: 7px 10px;
  font: 400 14px/1.5 var(--lb-font-sans);
  color: var(--lb-ink);
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}

.control[aria-invalid="true"] {
  border-style: dashed;
  border-width: 2px;
}

.chosen {
  font-size: 13.5px;
  font-weight: 600;
}

.problem {
  font-size: 13px;
  font-weight: 700;
}
</style>
