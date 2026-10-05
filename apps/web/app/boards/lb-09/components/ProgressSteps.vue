<script setup lang="ts">
// <ProgressSteps>: where the worker is with the meeting. The five stages are listed in order, each with what
// happens in it, and each is marked waiting, running, done or failed from the states the board has heard,
// never guessed: a stage is running only once the back end said so. The mark is an icon and a word, never
// colour alone. A meeting the worker has not taken yet says it waits for the worker. A failure names its
// reason in the visitor's words, marks the stage it failed in (from what the board saw, and the stage the
// reason belongs to when the board read the meeting only now and then), and says when the meeting gave
// its place for the day back. The panel also says honestly how the board hears about progress (over the
// WebSocket, by reading the meeting every second or two when the socket is not there, or from a recording
// in a replay), and counts the seconds since the meeting was sent.
import { LbIcon } from '@lb/icons'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { failedStage, givesPlaceBack } from '../outcome'
import { WORK_STAGES } from '../schemas'
import type { Failure, Mode, Stage } from '../schemas'
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
  /** Which transcriber the meeting runs on, for what the transcription stage says it does. */
  mode: Mode
  /** How the board hears about progress. */
  feed: ProgressFeed
  /** True for a replay. */
  replaying: boolean
  /** When the meeting was sent, in Unix milliseconds; undefined for a replay or a meeting opened again. */
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
const failed = computed(() => props.status === 'failed')
// The stage the failure is marked at; undefined when nothing says which it was.
const failedAt = computed(() => (failed.value ? failedStage(props.stages, props.failure) : undefined))

/** Marks one stage of a meeting that failed: those before the failing one done, the failing one failed. */
function failedMark(index: number): Mark {
  const at = failedAt.value === undefined ? -1 : WORK_STAGES.indexOf(failedAt.value)
  if (index < at) return 'done'
  return index === at ? 'failed' : 'waiting'
}

/** Marks each stage from what has been seen. */
const steps = computed(() => {
  const at = WORK_STAGES.indexOf(props.current as (typeof WORK_STAGES)[number])
  return WORK_STAGES.map((stage, index) => {
    let mark: Mark = 'waiting'
    if (props.status === 'done') mark = 'done'
    else if (failed.value) mark = failedMark(index)
    else if (index === at) mark = 'running'
    else if (props.stages.includes(stage) || (at >= 0 && index < at)) mark = 'done'
    return { stage, mark }
  })
})

// A failed meeting whose stage nothing says (lost by the worker before the board saw it work) shows its reason without steps.
const showSteps = computed(() => !failed.value || failedAt.value !== undefined)

/** Picks the icon for a stage's mark. */
function iconFor(mark: Mark): 'success' | 'play' | 'clock' | 'error' {
  switch (mark) {
    case 'done': return 'success'
    case 'running': return 'play'
    case 'waiting': return 'clock'
    default: return 'error'
  }
}

/** Says what a stage does; the transcription says which transcriber does it. */
function noteOf(stage: (typeof WORK_STAGES)[number]): string {
  return stage === 'transcribing' ? t(`lb09.progress.notes.transcribing.${props.mode}`) : t(`lb09.progress.notes.${stage}`)
}

const headline = computed(() => {
  if (props.replaying) return t('lb09.progress.replaying')
  if (props.status === 'done') return t('lb09.progress.done')
  if (failed.value) return t('lb09.progress.failedTitle')
  return t('lb09.progress.title')
})
const feedText = computed(() => {
  if (props.replaying) return t('lb09.progress.feed.replay')
  return t(`lb09.progress.feed.${props.feed === 'polling' ? 'polling' : 'socket'}`)
})
const failureText = computed(() => (props.failure ? t(`lb09.progress.failures.${props.failure}`) : t('lb09.progress.failures.pipeline_error')))
// A meeting the service could not finish gave the visitor's place back, which a replay has nothing to do with.
const givenBack = computed(() => failed.value && !props.replaying && givesPlaceBack(props.failure))
</script>

<template>
  <section
    class="progress"
    data-testid="progress"
    :data-status="status"
    aria-labelledby="lb09-progress-title"
  >
    <div class="head">
      <LbIcon
        :name="failed ? 'error' : status === 'done' ? 'success' : 'clock'"
        :size="20"
      />
      <h2
        id="lb09-progress-title"
        class="title"
      >
        {{ headline }}
      </h2>
    </div>
    <p
      v-if="status === 'received' && !replaying"
      class="text"
      data-testid="progress-queued"
    >
      {{ t('lb09.progress.queued') }}
    </p>
    <ol
      v-if="showSteps"
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
        :aria-current="step.mark === 'running' ? 'step' : undefined"
      >
        <LbIcon
          :name="iconFor(step.mark)"
          :size="16"
          tone="mono"
        />
        <span class="name">{{ t(`lb09.progress.stages.${step.stage}`) }}</span>
        <span class="mark">{{ t(`lb09.progress.marks.${step.mark}`) }}</span>
        <span class="note">{{ noteOf(step.stage) }}</span>
      </li>
    </ol>
    <p
      v-if="failed"
      class="text"
      data-testid="progress-failure"
    >
      {{ failureText }}
    </p>
    <p
      v-if="givenBack"
      class="text"
      data-testid="progress-given-back"
    >
      {{ t('lb09.progress.givenBack') }}
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
  </section>
</template>

<style scoped>
.progress {
  display: grid;
  gap: 10px;
  min-width: 0;
  padding: 12px 14px;
  background: var(--lb-board-tint);
  border: 1px dashed var(--lb-board);
}

.head {
  display: flex;
  gap: 10px;
  align-items: center;
}

.title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
}

.steps {
  display: grid;
  padding: 0;
  margin: 0;
  list-style: none;
  background: var(--lb-sheet);
  border: 1px solid var(--lb-rule);
}

.step {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 2px 10px;
  align-items: center;
  padding: 7px 10px;
  font-size: 13.5px;
  border-bottom: 1px solid var(--lb-rule);
}

.step:last-child {
  border-bottom: 0;
}

.name {
  font-weight: 600;
}

.mark {
  font-family: var(--lb-font-mono);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.note {
  grid-column: 2 / -1;
  font-size: 12.5px;
  color: var(--lb-graphite);
}

.step--running {
  background: var(--lb-board-tint);
}

.step--waiting .name,
.step--waiting .mark {
  color: var(--lb-graphite);
}

.step--failed .name,
.step--failed .mark {
  font-weight: 700;
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
