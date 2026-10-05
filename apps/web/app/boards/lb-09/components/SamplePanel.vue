<script setup lang="ts">
// <SamplePanel>: the curated meetings the demo opens on. The visitor chooses one (a group of radio
// buttons, so the arrow keys work and choosing starts nothing), reads what it is about and what it
// holds (speakers, length, decisions and actions in the golden set), and either replays its
// recording, which costs nothing, or runs it live, which spends one of the day's recordings. A sample
// with no recording says so and offers the live run only.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { PickerSample } from '~/board-kit/samples'

/** What the panel says about the chosen sample, from the golden set. */
export interface SampleFacts {
  seconds: number
  speakers: number
  decisions: number
  actions: number
}

const props = defineProps<{
  samples: readonly PickerSample[]
  /** The IDs of the samples that have a recording, or undefined while that is not known yet. */
  recorded: readonly string[] | undefined
  /** The facts of each sample, by its ID. */
  facts: Readonly<Record<string, SampleFacts>>
  /** A live meeting is going: another cannot be started until it is done. */
  busy: boolean
  /** Whether a live run can be started at all. */
  canRunLive: boolean
  /** The back end is there but the visitor has no recording left today. */
  allowanceUsedUp: boolean
}>()

const emit = defineEmits<{ replay: [id: string], run: [id: string] }>()

const selected = defineModel<string | undefined>({ required: true })

const { t } = useI18n()

const chosen = computed(() => props.samples.find(sample => sample.id === selected.value))
const chosenFacts = computed(() => (chosen.value ? props.facts[chosen.value.id] : undefined))
const hasRecording = computed(() => chosen.value !== undefined && props.recorded !== undefined && props.recorded.includes(chosen.value.id))
const recordingKnown = computed(() => props.recorded !== undefined)
</script>

<template>
  <section
    class="samples"
    data-testid="samples"
    :aria-labelledby="'lb09-samples-title'"
  >
    <h2
      id="lb09-samples-title"
      class="lb-label"
    >
      {{ t('lb09.samples.title') }}
    </h2>

    <BoardSamplePicker
      v-model="selected"
      :samples="samples"
      :recorded="recorded"
      :legend="t('lb09.samples.legend')"
    />

    <div
      v-if="chosen"
      class="chosen"
      data-testid="sample-chosen"
    >
      <p class="about">
        {{ chosen.note }}
      </p>
      <p
        v-if="chosenFacts"
        class="facts"
        data-testid="sample-facts"
      >
        {{ t('lb09.samples.facts', { speakers: chosenFacts.speakers, seconds: Math.round(chosenFacts.seconds), decisions: chosenFacts.decisions, actions: chosenFacts.actions }) }}
      </p>

      <p
        v-if="recordingKnown && !hasRecording"
        class="small"
        data-testid="sample-no-recording"
      >
        {{ t('lb09.samples.noRecording') }}
      </p>
      <p
        v-if="allowanceUsedUp"
        class="small"
        data-testid="sample-no-allowance"
      >
        {{ t('lb09.samples.noAllowance') }}
      </p>
      <p
        v-else-if="!canRunLive"
        class="small"
      >
        {{ t('lb09.samples.noLive') }}
      </p>
      <p
        v-else
        class="small"
      >
        {{ t('lb09.samples.liveCost') }}
      </p>

      <div class="buttons">
        <button
          v-if="hasRecording"
          type="button"
          class="button button--primary"
          data-testid="replay-sample"
          @click="emit('replay', chosen.id)"
        >
          {{ t('lb09.samples.replay') }}
        </button>
        <button
          type="button"
          class="button"
          :class="{ 'button--primary': !hasRecording }"
          data-testid="run-sample"
          :disabled="busy || !canRunLive"
          @click="emit('run', chosen.id)"
        >
          {{ t('lb09.samples.runLive') }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.samples {
  display: grid;
  gap: 12px;
  min-width: 0;
}

.chosen {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--lb-rule);
}

.about {
  font-size: 14px;
}

.facts {
  font-family: var(--lb-font-mono);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}

.small {
  font-size: 13px;
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
