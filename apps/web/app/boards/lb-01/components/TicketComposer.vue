<script setup lang="ts">
// <TicketComposer>: where a visitor files a ticket. It opens on the curated samples: a sample with
// a recording replays it for free, and one without says so and offers the live run, which uses
// one of the day's tickets. The second way in is the visitor's own text as a chosen synthetic
// customer, which is always a live run and is the only path that reaches the Turnstile check.
// This component only collects the choice and reports it; the board decides what to do with it.
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { PickerSample } from '~/board-kit/samples'

import type { Customer } from '../schemas'
import type { NewTicket } from '../store'

/** The longest ticket the API accepts. */
const MAX_BODY = 2_000

const props = defineProps<{
  samples: readonly PickerSample[]
  /** The IDs of the samples that have a recording, or undefined while that is not known yet. */
  recorded: readonly string[] | undefined
  customers: readonly Customer[]
  /** True while a ticket is being filed or its pipeline is running. */
  busy: boolean
  /** Whether a live run is possible: the deployment has a back end and the day's tickets are not used up. */
  canRunLive: boolean
  /** The language to start the form in: the one the site is shown in. */
  defaultLanguage: 'en' | 'cs'
  /** The full text of each sample, by ID, so the visitor can read what the customer wrote before choosing. */
  bodies: Readonly<Record<string, string>>
}>()

const emit = defineEmits<{
  replay: [sampleId: string]
  runSample: [sampleId: string]
  file: [ticket: NewTicket]
}>()

const { t } = useI18n()

const source = ref<'sample' | 'own'>('sample')
const chosen = ref<string | undefined>(props.samples[0]?.id)
const customer = ref('')
const language = ref<'en' | 'cs'>(props.defaultLanguage)
const body = ref('')

const sourceOptions = computed(() => [
  { value: 'sample' as const, label: t('lb01.compose.samples') },
  { value: 'own' as const, label: t('lb01.compose.own') },
])
const languageOptions = computed(() => [
  { value: 'en' as const, label: t('lb01.compose.languages.en') },
  { value: 'cs' as const, label: t('lb01.compose.languages.cs') },
])

const hasRecording = computed(() => chosen.value !== undefined && props.recorded?.includes(chosen.value) === true)
const recordingKnown = computed(() => props.recorded !== undefined)
const chosenBody = computed(() => (chosen.value === undefined ? '' : props.bodies[chosen.value] ?? ''))
const chosenLanguage = computed(() => props.samples.find(sample => sample.id === chosen.value)?.language ?? 'en')
const bodyLength = computed(() => body.value.length)
const canFile = computed(() => !props.busy && props.canRunLive && customer.value !== '' && body.value.trim().length > 0 && bodyLength.value <= MAX_BODY)

// Start with the first customer once the list arrives, and keep a choice the visitor made.
watch(() => props.customers, (list) => {
  if (customer.value === '' || !list.some(item => item.key === customer.value)) customer.value = list[0]?.key ?? ''
}, { immediate: true })

/** Reports the sample the visitor chose: replayed if it has a recording, live if it has not. */
function startSample(): void {
  if (chosen.value === undefined) return
  if (hasRecording.value) emit('replay', chosen.value)
  else emit('runSample', chosen.value)
}

/** Reports the ticket the visitor wrote. */
function fileOwn(): void {
  if (canFile.value) emit('file', { customer: customer.value, language: language.value, body: body.value.trim() })
}
</script>

<template>
  <section
    class="composer"
    :aria-label="t('lb01.compose.title')"
  >
    <h2 class="lb-label">
      {{ t('lb01.compose.title') }}
    </h2>
    <LbSegmented
      v-model="source"
      :options="sourceOptions"
      :label="t('lb01.compose.modeLabel')"
    />

    <div
      v-if="source === 'sample'"
      class="pane"
    >
      <BoardSamplePicker
        v-model="chosen"
        :samples="samples"
        :recorded="recorded"
        :legend="t('lb01.compose.samplesLegend')"
      />
      <figure
        v-if="chosenBody"
        class="preview"
      >
        <figcaption class="lb-label">
          {{ t('lb01.compose.customerWrites') }}
        </figcaption>
        <blockquote :lang="chosenLanguage">
          {{ chosenBody }}
        </blockquote>
      </figure>
      <p
        v-if="recordingKnown && !hasRecording"
        class="hint"
        data-testid="no-recording"
      >
        {{ t('lb01.compose.noRecording') }} {{ t('lb01.compose.liveCost') }}
      </p>
      <div class="buttons">
        <button
          type="button"
          class="button button--primary"
          :disabled="chosen === undefined || !recordingKnown || (!hasRecording && (busy || !canRunLive))"
          data-testid="start-sample"
          @click="startSample"
        >
          {{ hasRecording ? t('lb01.compose.replay') : t('lb01.compose.runSampleLive') }}
        </button>
        <button
          v-if="hasRecording && canRunLive"
          type="button"
          class="button"
          :disabled="busy"
          data-testid="run-sample-live"
          @click="chosen && emit('runSample', chosen)"
        >
          {{ t('lb01.compose.runInstead') }}
        </button>
      </div>
      <p
        v-if="!canRunLive"
        class="hint"
      >
        {{ t('lb01.compose.noLive') }}
      </p>
    </div>

    <form
      v-else
      class="pane"
      @submit.prevent="fileOwn"
    >
      <div class="field">
        <label for="lb01-customer">{{ t('lb01.compose.customer') }}</label>
        <select
          id="lb01-customer"
          v-model="customer"
          class="control"
          aria-describedby="lb01-customer-hint"
        >
          <option
            v-for="item in customers"
            :key="item.key"
            :value="item.key"
          >
            {{ item.name }} ({{ item.language.toUpperCase() }})
          </option>
        </select>
        <p
          id="lb01-customer-hint"
          class="hint"
        >
          {{ t('lb01.compose.customerHint') }}
        </p>
      </div>

      <div class="field">
        <span class="field-label">{{ t('lb01.compose.language') }}</span>
        <LbSegmented
          v-model="language"
          :options="languageOptions"
          :label="t('lb01.compose.language')"
        />
      </div>

      <div class="field">
        <label for="lb01-body">{{ t('lb01.compose.body') }}</label>
        <textarea
          id="lb01-body"
          v-model="body"
          class="control"
          rows="5"
          :maxlength="MAX_BODY"
          :lang="language"
          aria-describedby="lb01-body-hint"
        />
        <p
          id="lb01-body-hint"
          class="hint"
        >
          {{ t('lb01.compose.bodyHint') }}
          <span class="count">{{ t('lb01.compose.counter', { count: bodyLength, max: MAX_BODY }) }}</span>
        </p>
      </div>

      <div class="buttons">
        <button
          type="submit"
          class="button button--primary"
          :disabled="!canFile"
          data-testid="file-ticket"
        >
          {{ busy ? t('lb01.compose.filing') : t('lb01.compose.submit') }}
        </button>
      </div>
      <p
        v-if="!canRunLive"
        class="hint"
      >
        {{ t('lb01.compose.noLive') }}
      </p>
    </form>

    <p class="hint">
      {{ t('lb01.compose.privacy') }}
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

.preview {
  display: grid;
  gap: 4px;
  margin: 0;
}

blockquote {
  padding: 8px 12px;
  margin: 0;
  font-style: italic;
  background: var(--lb-shade);
  border-left: 3px solid var(--lb-rule);
}

.field {
  display: grid;
  gap: 4px;
  justify-items: start;
}

.field label,
.field-label {
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

textarea.control {
  resize: vertical;
}

.hint {
  font-size: 12.5px;
  color: var(--lb-graphite);
}

.count {
  margin-left: 8px;
  font-family: var(--lb-font-mono);
  font-variant-numeric: tabular-nums;
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
</style>
