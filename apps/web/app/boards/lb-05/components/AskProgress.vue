<script setup lang="ts">
// <AskProgress>: what the board says while a question is being worked on. The analyst answers in
// one long request and reports nothing while it works, so the board does not pretend to know which
// step it is on: it says what is happening, counts the seconds used of the seconds a question is given
// (a clock, not an estimate), says honestly that the steps and the Scope fill in when the answer
// arrives, offers to stop waiting, and says when the wait is longer than usual. For a replay it says
// the recorded steps are playing instead. The count is drawn as text and as a bar that is decoration.
import { LbIcon } from '@lb/icons'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { secondsSince } from '../limits'

/** After this many seconds a question is taking longer than usual. */
const SLOW_AFTER_SECONDS = 30

const props = defineProps<{
  /** When the request began, in Unix milliseconds; undefined for a replay. */
  startedAt: number | undefined
  /** The seconds a question is given in all. */
  totalSeconds: number
  /** True for a replay, which has no request to count. */
  replaying: boolean
  /** The current time in Unix milliseconds at the start, so the count can be tested. */
  now?: number
}>()

const emit = defineEmits<{ stop: [] }>()

const { t } = useI18n()

// The clock advances once a second while the component is on the page.
const clock = ref(props.now ?? Date.now())
let timer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  timer = setInterval(() => {
    clock.value = props.now === undefined ? Date.now() : clock.value + 1_000
  }, 1_000)
})

onBeforeUnmount(() => {
  if (timer !== undefined) clearInterval(timer)
})

const elapsed = computed(() => (props.startedAt === undefined ? 0 : Math.min(secondsSince(props.startedAt, clock.value), props.totalSeconds)))
const share = computed(() => (props.totalSeconds > 0 ? Math.round((elapsed.value / props.totalSeconds) * 100) : 0))
const slow = computed(() => !props.replaying && elapsed.value >= SLOW_AFTER_SECONDS)
// Before the request begins, a live question is waiting for the check that the visitor is a person.
const headline = computed(() => {
  if (props.replaying) return t('lb05.progress.replaying')
  return props.startedAt === undefined ? t('lb05.progress.checking') : t('lb05.progress.title')
})
</script>

<template>
  <div
    class="progress"
    data-testid="progress"
  >
    <LbIcon
      name="clock"
      :size="20"
    />
    <div class="body">
      <p class="title">
        {{ headline }}
      </p>
      <template v-if="!replaying">
        <template v-if="startedAt !== undefined">
          <p class="text">
            {{ t('lb05.progress.text', { seconds: totalSeconds }) }}
          </p>
          <p
            class="elapsed"
            data-testid="elapsed"
          >
            {{ t('lb05.progress.elapsed', { elapsed, total: totalSeconds }) }}
          </p>
          <div
            class="meter"
            aria-hidden="true"
          >
            <div
              class="fill"
              :style="{ width: `${share}%` }"
            />
          </div>
          <p
            v-if="slow"
            class="text"
            data-testid="slow"
          >
            {{ t('lb05.progress.slow') }}
          </p>
        </template>
        <div class="actions">
          <button
            type="button"
            class="button"
            data-testid="stop-waiting"
            @click="emit('stop')"
          >
            {{ t('lb05.progress.stop') }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.progress {
  display: flex;
  gap: 12px;
  padding: 12px 14px;
  background: var(--lb-board-tint);
  border: 1px dashed var(--lb-board);
}

.body {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.title {
  font-weight: 700;
}

.text {
  font-size: 14px;
}

.elapsed {
  font-family: var(--lb-font-mono);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}

.meter {
  height: 6px;
  background: var(--lb-sheet);
  border: 1px solid var(--lb-ink);
}

.fill {
  height: 100%;
  background: var(--lb-board-mark);
}

.actions {
  display: flex;
  margin-top: 4px;
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

.button:hover {
  background: var(--lb-sheet);
}
</style>
