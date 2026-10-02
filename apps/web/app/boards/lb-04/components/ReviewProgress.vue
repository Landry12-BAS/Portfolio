<script setup lang="ts">
// <ReviewProgress>: how a review is going, by the state the service says the contract is in: queued (waiting
// for a worker), extracting (the PDF's text and where each word sits), analysing (the injection screen and
// the first model reading the contract against the playbook) and verifying (the server checking every quote
// against the text, and the second model rating what survived). Nothing here is a guess: each step is
// marked from the state the service reported at the last poll, and the page never moves a step on by
// itself. A review takes between ten seconds and a minute, so the board counts the time honestly and
// offers to stop waiting; the service goes on with the review, which still counts for the day.
import { LbIcon } from '@lb/icons'
import type { Lb04State } from '@lb/contracts'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { formatDuration } from '~/board-kit/format'

const props = defineProps<{
  state: Lb04State
  /** How many pages the file has, once it has been opened. */
  pages: number | null
  /** When the live review began, in Unix milliseconds; nothing for a replay, which has no wait to count. */
  startedAt: number | undefined
  replaying: boolean
}>()

const emit = defineEmits<{ stop: [] }>()

const { t, locale } = useI18n()

/** The steps a review goes through, in order. */
const STEPS = ['queued', 'extracting', 'analysing', 'verifying'] as const

const index = computed(() => STEPS.indexOf(props.state as (typeof STEPS)[number]))
const steps = computed(() => STEPS.map((step, position) => ({
  step,
  status: props.state === 'done' || position < index.value ? 'done' : position === index.value ? 'now' : 'next',
})))

const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined

/** Stops the clock that counts the wait. */
function stopTicker(): void {
  if (ticker !== undefined) clearInterval(ticker)
  ticker = undefined
}

// The clock runs only while a live review is being waited for.
watch(() => props.startedAt, (since) => {
  stopTicker()
  if (since === undefined || typeof window === 'undefined') return
  now.value = Date.now()
  ticker = setInterval(() => {
    now.value = Date.now()
  }, 1_000)
}, { immediate: true })

onBeforeUnmount(stopTicker)

const elapsed = computed(() => (props.startedAt === undefined ? undefined : formatDuration(Math.max(now.value - props.startedAt, 0), locale.value)))
</script>

<template>
  <section
    class="lb4-section progress"
    aria-labelledby="lb4-progress-heading"
    data-testid="progress"
    :data-state="state"
  >
    <h2 id="lb4-progress-heading">
      {{ replaying ? t('lb04.progress.titleReplay') : t('lb04.progress.title') }}
    </h2>

    <ol class="steps">
      <li
        v-for="entry in steps"
        :key="entry.step"
        class="step"
        :data-status="entry.status"
        :aria-current="entry.status === 'now' ? 'step' : undefined"
      >
        <span
          class="mark"
          aria-hidden="true"
        >
          <LbIcon
            v-if="entry.status === 'done'"
            name="check"
            :size="16"
          />
          <span
            v-else-if="entry.status === 'now'"
            class="spinner"
          />
        </span>
        <span class="text">
          <span class="name">{{ t(`lb04.progress.steps.${entry.step}.name`) }}</span>
          <span class="note">{{ t(`lb04.progress.steps.${entry.step}.note`) }}</span>
        </span>
        <span class="status">{{ t(`lb04.progress.status.${entry.status}`) }}</span>
      </li>
    </ol>

    <p
      class="lb4-hint"
      role="status"
    >
      <template v-if="replaying">
        {{ t('lb04.progress.replaying') }}
      </template>
      <template v-else>
        {{ t(`lb04.progress.live.${state}`, { pages: pages ?? 0 }) }}
        <span
          v-if="elapsed"
          class="lb4-nums"
        >{{ t('lb04.progress.elapsed', { time: elapsed }) }}</span>
      </template>
    </p>

    <div
      v-if="!replaying"
      class="lb4-row"
    >
      <button
        type="button"
        class="lb4-button lb4-button--quiet"
        @click="emit('stop')"
      >
        {{ t('lb04.progress.stop') }}
      </button>
      <span class="lb4-hint">{{ t('lb04.progress.stopNote') }}</span>
    </div>
  </section>
</template>

<style scoped>
.steps {
  display: grid;
  gap: 6px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.step {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  gap: 4px 10px;
  align-items: start;
  padding: 8px 12px;
  background: var(--lb-sheet);
  border: 1px solid var(--lb-rule);
}

.step[data-status="now"] {
  border: 2px solid var(--lb-signal);
}

.step[data-status="next"] {
  color: var(--lb-graphite);
}

.mark {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
}

.text {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.name {
  font-weight: 700;
}

.note {
  font-size: 13px;
  color: var(--lb-graphite);
}

.status {
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--lb-rule);
  border-top-color: var(--lb-signal);
  border-radius: 50%;
  animation: lb4-spin 0.9s linear infinite;
}

@keyframes lb4-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
