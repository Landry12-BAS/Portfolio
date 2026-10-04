<script setup lang="ts">
// <ProgressSteps>: where the worker is with the meeting. The five stages are listed in order and
// each is marked as waiting, running, done or failed from the states the board has heard, never
// guessed: a stage is running only once the back end said so. The panel also says honestly how the
// board hears about progress (over the WebSocket, by reading the meeting every second or two when
// the socket is not there, or from a recording in a replay), and counts the seconds since the meeting
// was sent. A failure names its reason in the visitor's words.
import { LbIcon } from '@lb/icons'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { WORK_STAGES } from '../schemas'
import type { Failure, Stage } from '../schemas'
import type { ProgressFeed } from '../store'

/** How a stage is drawn. */
type Mark = 'waiting' | 'running' | 'done' | 'failed'

const props = defineProps<{
  /** The stages the meeting has been seen to reach, in order. */
  stages: readonly Stage[]
  /** The stage the meeting is at now. */
  current: Stage
  /** Whether the meeting is over, and how. */
  status: 'received' | 'processing' | 'done' | 'failed'
  /** Why it failed, when it did. */
  failure: Failure | null
  /** How the board hears about progress. */
  feed: ProgressFeed
  /** True for a replay. */
  replaying: boolean
  /** When the meeting was sent, in Unix milliseconds; undefined for a replay. */
  startedAt: number | undefined
  /** The current time in Unix milliseconds at the start, so the count can be tested. */
  now?: number
}>()

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

const elapsed = computed(() => (props.startedAt === undefined ? 0 : Math.max(Math.floor((clock.value - props.startedAt) / 1_000), 0)))
const over = computed(() => props.status === 'done' || props.status === 'failed')

/** Marks each stage from what has been seen. */
const steps = computed(() => {
  const reached = props.stages
  const at = WORK_STAGES.indexOf(props.current as (typeof WORK_STAGES)[number])
  return WORK_STAGES.map((stage, index) => {
    let mark: Mark = 'waiting'
    if (props.status === 'done') mark = 'done'
    else if (props.status === 'failed') mark = reached.includes(stage) ? (index === lastReached.value ? 'failed' : 'done') : 'waiting'
    else if (index === at) mark = 'running'
    else if (reached.includes(stage) || (at >= 0 && index < at)) mark = 'done'
    return { stage, mark }
  })
})

// The last of the work stages the meeting reached, where a failure is marked.
const lastReached = computed(() => {
  let last = -1
  for (const stage of props.stages) {
    const index = WORK_STAGES.indexOf(stage as (typeof WORK_STAGES)[number])
    if (index > last) last = index
  }
  return last
})

const headline = computed(() => {
  if (props.replaying) return t('lb09.progress.replaying')
  if (props.status === 'done') return t('lb09.progress.done')
  if (props.status === 'failed') return t('lb09.progress.failedTitle')
  return t('lb09.progress.title')
})
const feedText = computed(() => {
  if (props.replaying) return t('lb09.progress.feed.replay')
  return t(`lb09.progress.feed.${props.feed === 'polling' ? 'polling' : 'socket'}`)
})
const failureText = computed(() => (props.failure ? t(`lb09.progress.failures.${props.failure}`) : t('lb09.progress.failures.pipeline_error')))
</script>

<template>
  <div
    class="progress"
    data-testid="progress"
    :data-status="status"
  >
    <LbIcon
      :name="status === 'failed' ? 'error' : status === 'done' ? 'success' : 'clock'"
      :size="20"
    />
    <div class="body">
      <p class="title">
        {{ headline }}
      </p>
      <ol
        class="steps"
        data-testid="stages"
      >
        <li
          v-for="step in steps"
          :key="step.stage"
          class="step"
          :class="`step--${step.mark}`"
          :data-stage="step.stage"
          :data-mark="step.mark"
        >
          <span
            class="dot"
            aria-hidden="true"
          />
          <span class="name">{{ t(`lb09.progress.stages.${step.stage}`) }}</span>
          <span class="lb-sr-only">{{ t(`lb09.progress.marks.${step.mark}`) }}</span>
        </li>
      </ol>
      <p
        v-if="status === 'failed'"
        class="text"
        data-testid="progress-failure"
      >
        {{ failureText }}
      </p>
      <p
        v-if="!over"
        class="feed"
        data-testid="progress-feed"
      >
        {{ feedText }}
      </p>
      <p
        v-if="!replaying && startedAt !== undefined && !over"
        class="elapsed"
        data-testid="elapsed"
      >
        {{ t('lb09.progress.elapsed', { elapsed }) }}
      </p>
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
  gap: 8px;
  min-width: 0;
}

.title {
  font-weight: 700;
}

.steps {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.step {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 13.5px;
}

.dot {
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--lb-ink);
  border-radius: 50%;
}

.step--running .dot {
  background: var(--lb-board);
  border-color: var(--lb-board);
}

.step--done .dot {
  background: var(--lb-ink);
}

.step--failed .dot {
  background: var(--lb-marker);
  border-color: var(--lb-marker);
}

.step--waiting {
  color: var(--lb-graphite);
}

.text {
  font-size: 14px;
}

.feed,
.elapsed {
  font-family: var(--lb-font-mono);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}
</style>
