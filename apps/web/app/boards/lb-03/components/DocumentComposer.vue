<script setup lang="ts">
// <DocumentComposer>: where a visitor chooses a document. It opens on the six curated samples: a sample
// with a recording replays it for free, and one without says so and offers the live run, which uses one
// of the day's ten documents. The second way in is the visitor's own file, which is always a live run and
// is the only path that reaches the Turnstile check. The quick checks it makes on a chosen file (not
// empty, not over what the site passes on, a kind the reader knows) are for the visitor's sake; the site
// and the service check again, by the file's first bytes. This component only collects the choice and
// reports it; the board decides what to do with it.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { InvoiceSample } from '#shared/data/samples/lb03-types'
import { LB03_SITE_FILE_BYTES } from '#shared/lb03-limits'

import type { PickerSample } from '~/board-kit/samples'

import { checkChosenFile, formatSize } from '../upload'
import type { FileProblem } from '../upload'
import { sampleFileUrl, samplePageUrl } from '../urls'

const props = defineProps<{
  /** The curated documents, with what each prints. */
  catalog: readonly InvoiceSample[]
  /** The same samples as the picker shows them. */
  samples: readonly PickerSample[]
  /** The IDs of the samples that have a recording, or undefined while that is not known yet. */
  recorded: readonly string[] | undefined
  /** True while a file is being sent or a document is being read. */
  busy: boolean
  /** Whether a live run is possible: the deployment has a back end, the day's documents are not used up and the reader is taking documents. */
  canRunLive: boolean
  /** True when a live run is off because the day's documents are used up, so the hint can say that and not blame the site. */
  allowanceUsedUp: boolean
  /** True when the service says it cannot read documents right now (no model is reachable). */
  readerOff: boolean
  /** The most pages the service reads, from its own limits. */
  maxPages: number
}>()

const emit = defineEmits<{
  replay: [sampleId: string]
  runSample: [sampleId: string]
  upload: [file: File]
}>()

const { t, locale } = useI18n()

const source = ref<'sample' | 'own'>('sample')
const chosen = ref<string | undefined>(props.samples[0]?.id)
const file = ref<File>()
const problem = ref<FileProblem>()

// The site's limit in megabytes, as the datasheet says it ("4 MB").
const limitMegabytes = LB03_SITE_FILE_BYTES / 1_048_576

const sourceOptions = computed(() => [
  { value: 'sample' as const, label: t('lb03.compose.samples') },
  { value: 'own' as const, label: t('lb03.compose.own') },
])

const hasRecording = computed(() => chosen.value !== undefined && props.recorded?.includes(chosen.value) === true)
const recordingKnown = computed(() => props.recorded !== undefined)
const chosenSample = computed(() => props.catalog.find(sample => sample.id === chosen.value))
const canUpload = computed(() => !props.busy && props.canRunLive && file.value !== undefined)
// Why a live run is off, in the visitor's words: no document left today, the reader is off, or this copy of the site has no back end.
const liveHint = computed(() => {
  if (props.canRunLive) return undefined
  if (props.allowanceUsedUp) return 'lb03.compose.noAllowance'
  return props.readerOff ? 'lb03.compose.readerOff' : 'lb03.compose.noLive'
})

/** Reports the sample the visitor chose: replayed if it has a recording, live if it has not. */
function startSample(): void {
  if (chosen.value === undefined) return
  if (hasRecording.value) emit('replay', chosen.value)
  else emit('runSample', chosen.value)
}

/** Takes the file the visitor chose, or says why it is not worth sending and forgets it. */
function choose(event: Event): void {
  const input = event.target as HTMLInputElement
  const picked = input.files?.[0]
  file.value = undefined
  problem.value = undefined
  if (picked === undefined) return
  const found = checkChosenFile(picked)
  if (found !== undefined) {
    problem.value = found
    input.value = ''
    return
  }
  file.value = picked
}

/** Reports the file the visitor chose. */
function submit(): void {
  if (file.value !== undefined && canUpload.value) emit('upload', file.value)
}
</script>

<template>
  <section
    class="composer"
    :aria-label="t('lb03.compose.title')"
  >
    <h2 class="lb-label">
      {{ t('lb03.compose.title') }}
    </h2>
    <LbSegmented
      v-model="source"
      class="switch"
      :options="sourceOptions"
      :label="t('lb03.compose.modeLabel')"
    />

    <div
      v-if="source === 'sample'"
      class="pane"
    >
      <BoardSamplePicker
        v-model="chosen"
        :samples="samples"
        :recorded="recorded"
        :legend="t('lb03.compose.samplesLegend')"
      />
      <figure
        v-if="chosenSample"
        class="preview"
        data-testid="sample-preview"
      >
        <img
          class="page"
          :src="samplePageUrl(chosenSample.id, 1)"
          :alt="t('lb03.compose.previewAlt', { title: t(`lb03.samples.${chosenSample.id}.title`) })"
          loading="lazy"
        >
        <figcaption class="about">
          <span class="lb-label">{{ t('lb03.compose.previewCaption') }}</span>
          <span class="prints">{{ t('lb03.compose.prints', { type: t(`lb03.documentTypes.${chosenSample.documentType}`), vendor: chosenSample.vendor, number: chosenSample.number, total: chosenSample.total, currency: chosenSample.currency }) }}</span>
          <span class="shows">{{ t(`lb03.samples.${chosenSample.id}.note`) }}</span>
          <a
            class="save"
            :href="sampleFileUrl(chosenSample.file)"
            :download="chosenSample.file"
            data-testid="save-sample"
          >{{ t('lb03.compose.saveSample', { name: chosenSample.file, size: formatSize(chosenSample.bytes, locale) }) }}</a>
        </figcaption>
      </figure>
      <p
        v-if="recordingKnown && !hasRecording"
        class="hint"
        data-testid="no-recording"
      >
        {{ t('lb03.compose.noRecording') }} {{ t('lb03.compose.liveCost') }}
      </p>
      <div class="buttons">
        <button
          type="button"
          class="button button--primary"
          :disabled="chosen === undefined || !recordingKnown || (!hasRecording && (busy || !canRunLive))"
          data-testid="start-sample"
          @click="startSample"
        >
          {{ hasRecording ? t('lb03.compose.replay') : t('lb03.compose.runSampleLive') }}
        </button>
        <button
          v-if="hasRecording && canRunLive"
          type="button"
          class="button"
          :disabled="busy"
          data-testid="run-sample-live"
          @click="chosen && emit('runSample', chosen)"
        >
          {{ t('lb03.compose.runInstead') }}
        </button>
      </div>
      <p
        v-if="liveHint"
        class="hint"
        data-testid="live-hint"
      >
        {{ t(liveHint) }}
      </p>
    </div>

    <form
      v-else
      class="pane"
      @submit.prevent="submit"
    >
      <div class="field">
        <label for="lb03-file">{{ t('lb03.compose.fileLabel') }}</label>
        <input
          id="lb03-file"
          type="file"
          class="control"
          accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp"
          aria-describedby="lb03-file-hint lb03-file-state"
          data-testid="file-input"
          @change="choose"
        >
        <p
          id="lb03-file-hint"
          class="hint"
        >
          {{ t('lb03.compose.fileHint', { size: limitMegabytes, pages: maxPages }) }}
        </p>
        <p
          id="lb03-file-state"
          class="hint"
          :role="problem ? 'alert' : 'status'"
          :data-testid="problem ? 'file-problem' : 'file-chosen'"
        >
          <template v-if="problem">
            {{ t(`lb03.compose.problems.${problem}`, { size: limitMegabytes }) }}
          </template>
          <template v-else-if="file">
            {{ t('lb03.compose.chosen', { name: file.name, size: formatSize(file.size, locale) }) }}
          </template>
          <template v-else>
            {{ t('lb03.compose.noneChosen') }}
          </template>
        </p>
      </div>

      <div class="buttons">
        <button
          type="submit"
          class="button button--primary"
          :disabled="!canUpload"
          data-testid="upload"
        >
          {{ busy ? t('lb03.compose.sending') : t('lb03.compose.submit') }}
        </button>
      </div>
      <p
        v-if="liveHint"
        class="hint"
        data-testid="live-hint"
      >
        {{ t(liveHint) }}
      </p>
    </form>

    <p class="hint">
      {{ t('lb03.compose.privacy') }}
    </p>
  </section>
</template>

<style scoped>
.composer {
  display: grid;
  gap: 12px;
  min-width: 0;
}

.pane {
  display: grid;
  gap: 12px;
  min-width: 0;
}

/* The switch is a row of buttons, not a bar across the column. */
.switch {
  justify-self: start;
}

.preview {
  display: grid;
  grid-template-columns: minmax(0, 150px) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
  margin: 0;
}

.page {
  width: 100%;
  height: auto;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-rule);
}

.about {
  display: grid;
  gap: 6px;
  justify-items: start;
  min-width: 0;
}

.prints {
  font-size: 14px;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.shows {
  font-size: 13px;
  color: var(--lb-graphite);
}

.save {
  font-size: 13px;
  color: var(--lb-ink);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.field {
  display: grid;
  gap: 4px;
  justify-items: start;
}

.field label {
  font-size: 13px;
  font-weight: 700;
}

.control {
  width: 100%;
  padding: 8px 10px;
  font: 400 14px/1.5 var(--lb-font-sans);
  color: var(--lb-ink);
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}

.hint {
  font-size: 12.5px;
  color: var(--lb-graphite);
}

.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.button {
  padding: 9px 18px;
  font: 600 13.5px/1 var(--lb-font-sans);
  color: var(--lb-ink);
  cursor: pointer;
  background: transparent;
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}

.button:hover:not(:disabled) {
  background: var(--lb-shade);
}

.button--primary {
  color: var(--lb-sheet);
  background: var(--lb-ink);
}

.button--primary:hover:not(:disabled) {
  background: var(--lb-ink-hover);
}

.button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

@media (max-width: 520px) {
  .preview {
    grid-template-columns: minmax(0, 1fr);
  }

  .page {
    max-width: 220px;
  }
}
</style>
