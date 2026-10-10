<script setup lang="ts">
// <QuestionComposer>: where a visitor asks a business question. It opens on the curated questions: a
// question with a recording replays it for free, and one without says so and offers the live run,
// which uses one of the day's questions. The second way in is the visitor's own text, which is always a
// live run and is the only path that reaches the Turnstile check. This component only collects the
// choice and reports it; the board decides what to do with it.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { PickerSample } from '~/board-kit/samples'

import QuestionBox from './QuestionBox.vue'

const props = defineProps<{
  samples: readonly PickerSample[]
  /** The IDs of the questions that have a recording, or undefined while that is not known yet. */
  recorded: readonly string[] | undefined
  /** True while a question is being asked. */
  busy: boolean
  /** Whether a live run is possible: the deployment has a back end and the day's questions are not used up. */
  canRunLive: boolean
  /** True when a live run is off because the day's questions are used up, so the hint can say that and not blame the site. */
  allowanceUsedUp: boolean
}>()

const emit = defineEmits<{
  replay: [sampleId: string]
  runSample: [sampleId: string]
  ask: [question: string]
}>()

const { t } = useI18n()

const source = ref<'sample' | 'own'>('sample')
const chosen = ref<string | undefined>(props.samples[0]?.id)

const sourceOptions = computed(() => [
  { value: 'sample' as const, label: t('lb05.ask.samples') },
  { value: 'own' as const, label: t('lb05.ask.own') },
])

const hasRecording = computed(() => chosen.value !== undefined && props.recorded?.includes(chosen.value) === true)
const recordingKnown = computed(() => props.recorded !== undefined)
const chosenSample = computed(() => props.samples.find(sample => sample.id === chosen.value))
// Why a live run is off, in the visitor's words: no question left today, or this copy of the site has no back end.
const liveHint = computed(() => (props.canRunLive ? undefined : props.allowanceUsedUp ? 'lb05.ask.noAllowance' : 'lb05.ask.noLive'))

/** Reports the question the visitor chose: replayed if it has a recording, live if it has not. */
function startSample(): void {
  if (chosen.value === undefined) return
  if (hasRecording.value) emit('replay', chosen.value)
  else emit('runSample', chosen.value)
}
</script>

<template>
  <section
    class="composer"
    :aria-label="t('lb05.ask.title')"
  >
    <h2 class="lb-label">
      {{ t('lb05.ask.title') }}
    </h2>
    <LbSegmented
      v-model="source"
      class="switch"
      :options="sourceOptions"
      :label="t('lb05.ask.sourceLabel')"
    />

    <div
      v-if="source === 'sample'"
      class="pane"
    >
      <BoardSamplePicker
        v-model="chosen"
        :samples="samples"
        :recorded="recorded"
        :legend="t('lb05.ask.samplesLegend')"
      />
      <figure
        v-if="chosenSample"
        class="preview"
      >
        <figcaption class="lb-label">
          {{ t('lb05.ask.questionSent') }}
        </figcaption>
        <blockquote
          lang="en"
          data-testid="sample-question"
        >
          {{ chosenSample.excerpt }}
        </blockquote>
        <p class="shows">
          {{ chosenSample.note }}
        </p>
      </figure>
      <p
        v-if="recordingKnown && !hasRecording"
        class="hint"
        data-testid="no-recording"
      >
        {{ t('lb05.ask.noRecording') }} {{ t('lb05.ask.liveCost') }}
      </p>
      <div class="buttons">
        <button
          type="button"
          class="button button--primary"
          :disabled="chosen === undefined || !recordingKnown || (!hasRecording && (busy || !canRunLive))"
          data-testid="start-sample"
          @click="startSample"
        >
          {{ hasRecording ? t('lb05.ask.replay') : t('lb05.ask.runSampleLive') }}
        </button>
        <button
          v-if="hasRecording && canRunLive"
          type="button"
          class="button"
          :disabled="busy"
          data-testid="run-sample-live"
          @click="chosen && emit('runSample', chosen)"
        >
          {{ t('lb05.ask.runInstead') }}
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

    <div
      v-else
      class="pane"
    >
      <QuestionBox
        id-base="lb05-own"
        :label="t('lb05.ask.ownLabel')"
        :hint="t('lb05.ask.ownHint')"
        :submit-label="t('lb05.ask.submit')"
        :busy="busy"
        :disabled="!canRunLive"
        @submit="emit('ask', $event)"
      />
      <p
        v-if="liveHint"
        class="hint"
        data-testid="live-hint"
      >
        {{ t(liveHint) }}
      </p>
    </div>

    <p class="hint">
      {{ t('lb05.ask.privacy') }}
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
  gap: 4px;
  margin: 0;
}

.shows {
  font-size: 12.5px;
  color: var(--lb-graphite);
}

blockquote {
  padding: 8px 12px;
  margin: 0;
  font-style: italic;
  background: var(--lb-shade);
  border-left: 3px solid var(--lb-rule);
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
</style>
