<script setup lang="ts">
// <ReadProgress>: what the board says while a document is being read. The service reports where the
// document is (waiting for a reader, reading the page, extracting the fields, checking the arithmetic,
// repairing once, done) and the board shows exactly that: the stage it is in, the stages before it done,
// the ones after it waiting. It shows no percentage, because how long a stage takes depends on the queue
// and on the models, and a made-up bar is a lie. It says how many documents are ahead of this one, counts
// the seconds since the file was accepted (a clock, not an estimate), says when the wait is longer than
// usual and when the service gives up, and says that the trace opens in the Scope when the run is over.
// For a replay it says the recorded stages are playing instead.
import { LbIcon } from '@lb/icons'
import type { IconName } from '@lb/icons'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { SLOW_AFTER_SECONDS, STAGES, secondsSince, stageStatus } from '../progress'
import type { StageStatus } from '../progress'
import type { InvoiceDocument } from '../schemas'

const props = defineProps<{
  /** The document as the service last described it; undefined while the file is still being sent. */
  document: InvoiceDocument | undefined
  /** When the file was accepted, in Unix milliseconds; undefined while it is being sent and for a replay. */
  startedAt: number | undefined
  /** The seconds a document is given in all. */
  limitSeconds: number
  /** True for a replay, which has no request to count. */
  replaying: boolean
  /** The current time in Unix milliseconds at the start, so the count can be tested. */
  now?: number
}>()

const { t, locale } = useI18n()

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

const elapsed = computed(() => (props.startedAt === undefined ? 0 : Math.min(secondsSince(props.startedAt, clock.value), props.limitSeconds)))
const slow = computed(() => !props.replaying && props.startedAt !== undefined && elapsed.value >= SLOW_AFTER_SECONDS)

// Before the file is accepted, a live run is waiting for the check that the visitor is a person, and then for the upload.
const headline = computed(() => {
  if (props.replaying) return t('lb03.progress.replaying')
  return props.document === undefined ? t('lb03.progress.sending') : t('lb03.progress.title')
})

// The stages as the document stands: before there is a document every stage waits.
const stages = computed(() => {
  const document = props.document ?? { state: 'uploaded' as const, steps: [] }
  return STAGES.map(stage => ({ stage, status: props.document === undefined ? ('waiting' as const) : stageStatus(document, stage) }))
})

/** Picks the sentence about the queue, in the form the language's plural rules ask for. */
const queueText = computed(() => {
  const ahead = props.document?.state === 'uploaded' ? props.document.queued_ahead : null
  if (ahead === null || ahead === undefined) return undefined
  if (ahead === 0) return t('lb03.progress.next')
  const form = new Intl.PluralRules(locale.value).select(ahead)
  return t(QUEUE_KEYS[form === 'one' || form === 'few' ? form : 'other'], { count: ahead })
})

const ICONS: Partial<Record<StageStatus, IconName>> = { done: 'check', current: 'clock', failed: 'error' }
// The sentence about the queue for each form of the plural the language asks for (English has two, Czech three).
const QUEUE_KEYS = { one: 'lb03.progress.queueOne', few: 'lb03.progress.queueFew', other: 'lb03.progress.queueOther' } as const
</script>

<template>
  <section
    class="progress"
    :aria-label="t('lb03.progress.label')"
    data-testid="progress"
  >
    <LbIcon
      name="clock"
      :size="20"
    />
    <div class="body">
      <p
        class="title"
        role="status"
      >
        {{ headline }}
      </p>
      <ol
        class="stages"
        :aria-label="t('lb03.progress.stagesLabel')"
      >
        <li
          v-for="item in stages"
          :key="item.stage"
          class="stage"
          :data-state="item.status"
          data-testid="stage"
        >
          <span
            class="mark"
            aria-hidden="true"
          >
            <LbIcon
              v-if="ICONS[item.status]"
              :name="ICONS[item.status] as IconName"
              :size="16"
              tone="mono"
            />
            <span
              v-else
              class="shape"
            />
          </span>
          <span class="name">{{ t(`lb03.progress.stages.${item.stage}`) }}</span>
          <span class="state">{{ t(`lb03.progress.status.${item.status}`) }}</span>
        </li>
      </ol>
      <p
        v-if="queueText"
        class="text"
        data-testid="queue"
      >
        {{ queueText }}
      </p>
      <template v-if="!replaying && startedAt !== undefined">
        <p
          class="elapsed"
          data-testid="elapsed"
        >
          {{ t('lb03.progress.elapsed', { elapsed, total: limitSeconds }) }}
        </p>
        <p
          v-if="slow"
          class="text"
          data-testid="slow"
        >
          {{ t('lb03.progress.slow', { total: limitSeconds }) }}
        </p>
      </template>
      <p class="text note">
        {{ replaying ? t('lb03.progress.replayNote') : t('lb03.progress.honest') }}
      </p>
    </div>
  </section>
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

.stages {
  display: grid;
  gap: 4px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.stage {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  font-size: 14px;
}

.mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

/* A stage that is not done yet is a ring, and one that was not needed is a dash: the word beside it says it too. */
.shape {
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--lb-graphite);
  border-radius: 50%;
}

.stage[data-state="skipped"] .shape {
  height: 0;
  border-radius: 0;
  border-width: 1.5px 0 0;
}

.stage[data-state="current"] .name {
  font-weight: 700;
}

.stage[data-state="waiting"],
.stage[data-state="skipped"] {
  color: var(--lb-graphite);
}

.state {
  font-family: var(--lb-font-mono);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.text {
  font-size: 14px;
}

.note {
  font-size: 12.5px;
  color: var(--lb-graphite);
}

.elapsed {
  font-family: var(--lb-font-mono);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}
</style>
