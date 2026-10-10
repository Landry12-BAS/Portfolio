<script setup lang="ts">
// <BoardReplayBanner>: the label a replay always carries. It says that what is on the board is a
// recording of an earlier run, when it was made and where, that nothing is sent to a model and no
// quota is used, and it offers to play it again or to run the same thing live. A recording made
// on the test mock says so too; those exist only in the end-to-end build and are never shown to
// a real visitor.
import { LbIcon } from '@lb/icons'
import type { Recording } from '@lb/contracts'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { formatDay } from '~/board-kit/format'

const props = defineProps<{
  recording: Recording
  /** True while the recording is still playing. */
  playing: boolean
  /** Whether the board can run the same input live, which a deployment without a back end cannot. */
  canRunLive: boolean
}>()

const emit = defineEmits<{ again: [], live: [] }>()

const { t, locale } = useI18n()
const day = computed(() => formatDay(props.recording.recordedAt, locale.value))
</script>

<template>
  <div
    class="banner"
    data-testid="replay-banner"
  >
    <LbIcon
      name="replay"
      :size="20"
    />
    <div class="body">
      <p class="title">
        {{ t('board.replayBanner.title') }}
      </p>
      <p class="text">
        {{ recording.origin === 'live' ? t('board.replayBanner.recordedLive', { date: day }) : t('board.replayBanner.recordedMock', { date: day }) }}
        {{ t('board.replayBanner.free') }}
      </p>
      <div class="actions">
        <button
          type="button"
          class="button"
          :disabled="playing"
          @click="emit('again')"
        >
          {{ t('board.replayBanner.again') }}
        </button>
        <button
          v-if="canRunLive"
          type="button"
          class="button"
          @click="emit('live')"
        >
          {{ t('board.replayBanner.live') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  gap: 12px;
  padding: 12px 14px;
  background: var(--lb-board-tint);
  border: 1.5px dashed var(--lb-board);
}

.body {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.title {
  font-weight: 700;
}

.text {
  font-size: 14px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
}

.button {
  padding: 6px 12px;
  font: 600 13px/1 var(--lb-font-sans);
  color: var(--lb-ink);
  cursor: pointer;
  background: transparent;
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}

.button:hover:not(:disabled) {
  background: var(--lb-shade);
}

.button:disabled {
  color: var(--lb-graphite);
  cursor: not-allowed;
  border-color: var(--lb-graphite);
}
</style>
