<script setup lang="ts">
// <BoardSamplePicker>: the curated samples a demo opens on, as a group of radio buttons so the
// keyboard works the way it does everywhere (arrow keys move, space chooses). Choosing a sample
// starts nothing by itself; the board has its own button for that, so moving through the list
// with the arrow keys never spends anything. Each sample says whether a recording of it exists:
// a recorded sample can be replayed free, and one without says the run would be live.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { PickerSample } from '~/board-kit/samples'

const props = defineProps<{
  samples: readonly PickerSample[]
  /** The IDs of the samples that have a recording, or undefined while that is not known yet. */
  recorded: readonly string[] | undefined
  /** Names the group for assistive tech. */
  legend: string
}>()

const selected = defineModel<string | undefined>({ required: true })

const { t } = useI18n()
const recordedIds = computed(() => new Set(props.recorded ?? []))

/** Says whether a sample has a recording, has none, or it is not known yet. */
function recordingState(id: string): 'yes' | 'no' | 'unknown' {
  if (props.recorded === undefined) return 'unknown'
  return recordedIds.value.has(id) ? 'yes' : 'no'
}
</script>

<template>
  <fieldset
    class="picker"
    data-testid="sample-picker"
  >
    <legend class="lb-label">
      {{ legend }}
    </legend>
    <div class="grid">
      <label
        v-for="sample in samples"
        :key="sample.id"
        class="card"
        :class="{ chosen: selected === sample.id }"
      >
        <input
          v-model="selected"
          type="radio"
          name="sample"
          class="radio"
          :value="sample.id"
          :aria-describedby="`sample-${sample.id}-about`"
        >
        <span class="head">
          <span class="title">{{ sample.title }}</span>
          <span class="lang">{{ sample.language.toUpperCase() }}</span>
        </span>
        <span
          :id="`sample-${sample.id}-about`"
          class="about"
        >
          <span class="note">{{ sample.note }}</span>
          <span class="excerpt">{{ sample.excerpt }}</span>
          <span
            class="state"
            :data-recording="recordingState(sample.id)"
          >{{ t(`board.samples.recording.${recordingState(sample.id)}`) }}</span>
        </span>
      </label>
    </div>
  </fieldset>
</template>

<style scoped>
.picker {
  min-width: 0;
  padding: 0;
  margin: 0;
  border: 0;
}

.picker legend {
  padding: 0;
  margin-bottom: 8px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 8px;
}

.card {
  position: relative;
  display: grid;
  gap: 6px;
  align-content: start;
  padding: 10px 12px 10px 34px;
  cursor: pointer;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-rule);
}

.card:hover {
  border-color: var(--lb-ink);
}

.card.chosen {
  border-color: var(--lb-board);
  background: var(--lb-board-tint);
}

.card:has(.radio:focus-visible) {
  outline: 2px solid var(--lb-signal);
  outline-offset: 2px;
}

.radio {
  position: absolute;
  top: 12px;
  left: 11px;
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--lb-board);
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.title {
  font-weight: 700;
  font-size: 14px;
}

.lang {
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--lb-graphite);
}

.about {
  display: grid;
  gap: 4px;
  font-size: 12.5px;
}

.excerpt {
  display: -webkit-box;
  overflow: hidden;
  font-style: italic;
  color: var(--lb-graphite);
  line-clamp: 2;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.state {
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.state[data-recording="no"] {
  color: var(--lb-graphite);
}
</style>
