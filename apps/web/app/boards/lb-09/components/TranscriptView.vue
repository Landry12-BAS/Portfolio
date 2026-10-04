<script setup lang="ts">
// <TranscriptView>: the transcript, one stretch of speech at a time, with the speaker label the
// words suggest and the second it starts at. Every stretch is a button that jumps the player to its
// start, and the one being heard is marked as the player moves. The view says plainly that the
// labels were inferred from the words, not matched to voices: the transcriber hears one stream, and
// a model guessed who spoke from what was said.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { clockTime, withinSpan } from '../format'
import type { Transcript } from '../schemas'

const props = defineProps<{
  transcript: Transcript
  /** The second the player is at. */
  currentTime: number
}>()

const emit = defineEmits<{ seek: [seconds: number] }>()

const { t } = useI18n()

const heard = computed(() => props.transcript.segments.find(segment => withinSpan(props.currentTime, segment.start, segment.end))?.position)
</script>

<template>
  <section
    class="transcript"
    data-testid="transcript"
    :aria-labelledby="'lb09-transcript-title'"
  >
    <h2
      id="lb09-transcript-title"
      class="lb-label"
    >
      {{ t('lb09.transcript.title') }}
    </h2>
    <p class="note">
      {{ t('lb09.transcript.labelsNote') }}
    </p>
    <p
      v-if="transcript.segments.length === 0"
      class="note"
      data-testid="transcript-empty"
    >
      {{ t('lb09.transcript.empty') }}
    </p>
    <ol
      v-else
      class="segments"
    >
      <li
        v-for="segment in transcript.segments"
        :key="segment.position"
        class="segment"
        :class="{ heard: heard === segment.position }"
        :data-position="segment.position"
      >
        <button
          type="button"
          class="jump"
          :aria-label="t('lb09.transcript.jump', { label: segment.label, time: clockTime(segment.start) })"
          :aria-current="heard === segment.position ? 'true' : undefined"
          @click="emit('seek', segment.start)"
        >
          <span class="time">{{ clockTime(segment.start) }}</span>
          <span class="label">{{ segment.label }}</span>
          <span class="text">{{ segment.text }}</span>
        </button>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.transcript {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.note {
  font-size: 13px;
  color: var(--lb-graphite);
}

.segments {
  display: grid;
  gap: 4px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.jump {
  display: grid;
  grid-template-columns: 44px 92px 1fr;
  gap: 10px;
  width: 100%;
  padding: 6px 8px;
  font: inherit;
  font-size: 14px;
  color: var(--lb-ink);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
}

.jump:hover {
  background: var(--lb-shade);
}

.heard .jump {
  background: var(--lb-board-tint);
  border-color: var(--lb-board);
}

.time {
  font-family: var(--lb-font-mono);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  color: var(--lb-graphite);
}

.label {
  font-weight: 600;
}

.text {
  min-width: 0;
  overflow-wrap: anywhere;
}

@media (max-width: 560px) {
  .jump {
    grid-template-columns: 44px 1fr;
  }

  .text {
    grid-column: 1 / -1;
  }
}
</style>
