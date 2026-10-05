<script setup lang="ts">
// <RunProgress>: where the run stands, said plainly. Its state in words with an icon (never by colour alone) and the
// stage it is at, its model calls as a bar with the value written beside it (the cached results count among them),
// the time it has taken, what it measures and on which providers, and a button to stop waiting while it goes (the
// service goes on, and the run still counts). A failed run says why in the board's words and, for a failure the
// service gives back, whether it was given back, read from the day's count. A replay and a run opened again say so.
import { LbIcon } from '@lb/icons'
import type { IconName } from '@lb/icons'
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { SLOW_AFTER_MS } from '../pace'
import { isGivenBack, progressOf, stageOf } from '../report'
import { useLb10Store } from '../store'
import { useLb10Words } from '../words'

const { t } = useI18n()
const words = useLb10Words()
const store = useLb10Store()
const { run, runMode, phase, followedSince, refund, reopened, targets } = storeToRefs(store)
const id = useId()

// The clock the run's time is counted on, moved once a second while the board is open.
const now = ref(Date.now())
let ticking: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  ticking = setInterval(() => {
    now.value = Date.now()
  }, 1_000)
})
onBeforeUnmount(() => {
  if (ticking !== undefined) clearInterval(ticking)
})

const stage = computed(() => (run.value ? stageOf(run.value) : 'starting'))
const progress = computed(() => (run.value ? progressOf(run.value) : { done: 0, total: 0, cached: 0 }))
const share = computed(() => (progress.value.total > 0 ? Math.round((progress.value.done / progress.value.total) * 100) : 0))
const icon = computed<IconName>(() => {
  switch (run.value?.state) {
    case 'done': return 'success'
    case 'failed': return 'error'
    default: return 'live'
  }
})
const seconds = computed(() => {
  const view = run.value
  if (!view) return undefined
  const end = view.finished_at === null ? Math.max(now.value, Date.now()) : Date.parse(view.finished_at)
  return Math.max(0, Math.round((end - Date.parse(view.started_at)) / 1_000))
})
const targetTitle = computed(() => {
  const view = run.value
  if (!view) return ''
  const known = targets.value?.targets.find(item => item.pack === view.pack)
  return words.packTitle(view.pack, known?.name)
})
const providerNames = computed(() => (run.value?.providers ?? []).map(provider => words.providerName(provider)).join(', '))
const following = computed(() => runMode.value === 'live' && (phase.value === 'following' || phase.value === 'starting'))
const slow = computed(() => runMode.value === 'live' && phase.value === 'following' && followedSince.value !== undefined && now.value - followedSince.value > SLOW_AFTER_MS)
const failureText = computed(() => (run.value?.failure ? words.failureText(run.value.failure) : undefined))
const summary = computed(() => {
  const report = run.value?.report
  return report ? t('lb10.run.summary', { made: words.number(report.total_model_calls), cached: words.number(report.total_cached_calls) }) : undefined
})
</script>

<template>
  <section
    v-if="run"
    id="lb10-run"
    class="lb10-panel"
    :aria-labelledby="`${id}-title`"
    data-testid="run-panel"
  >
    <h2 :id="`${id}-title`">
      {{ t('lb10.run.title') }}
    </h2>
    <p
      class="state"
      role="status"
      data-testid="run-state"
      :data-state="run.state"
      :data-stage="stage"
    >
      <LbIcon
        :name="icon"
        :size="20"
        tone="mono"
      />
      <span>{{ words.stateWord(run.state) }}: {{ t(`lb10.run.stage.${stage}`) }}</span>
    </p>
    <div class="progress">
      <p
        :id="`${id}-progress`"
        class="lb10-label"
      >
        {{ t('lb10.run.progress') }}
      </p>
      <div
        class="lb10-bar"
        role="progressbar"
        :aria-labelledby="`${id}-progress`"
        :aria-valuemin="0"
        :aria-valuemax="progress.total"
        :aria-valuenow="progress.done"
        :aria-valuetext="t('lb10.run.progressValue', { done: words.number(progress.done), total: words.number(progress.total) })"
      >
        <div
          class="lb10-bar-fill"
          :style="{ width: `${share}%` }"
        />
      </div>
      <p
        class="lb10-nums"
        data-testid="run-calls"
      >
        {{ t('lb10.run.progressValue', { done: words.number(progress.done), total: words.number(progress.total) }) }}
        <span
          v-if="progress.cached > 0"
          class="lb10-hint"
        >· {{ t('lb10.run.progressCached', { cached: words.number(progress.cached) }) }}</span>
      </p>
    </div>
    <dl class="lb10-facts">
      <div>
        <dt>{{ t('lb10.run.target') }}</dt>
        <dd data-testid="run-target">
          {{ targetTitle }}
        </dd>
      </div>
      <div>
        <dt>{{ t('lb10.run.providers') }}</dt>
        <dd data-testid="run-providers">
          {{ providerNames }}
        </dd>
      </div>
      <div>
        <dt>{{ t('lb10.run.elapsedLabel') }}</dt>
        <dd data-testid="run-time">
          {{ seconds === undefined ? '–' : t('lb10.run.elapsed', { seconds: words.number(seconds) }) }}
        </dd>
      </div>
    </dl>
    <p
      v-if="summary"
      class="lb10-hint"
      data-testid="run-summary"
    >
      {{ summary }}
    </p>
    <div
      v-if="run.state === 'failed'"
      class="failure"
      data-testid="run-failure"
      :data-failure="run.failure"
    >
      <p class="failure-title">
        {{ t('lb10.failures.title') }}
      </p>
      <p v-if="failureText">
        {{ failureText }}
      </p>
      <p v-else>
        {{ t('lb10.failures.unknown') }} <span class="lb10-mono">{{ run.failure }}</span>
      </p>
      <p
        v-if="refund === 'checking'"
        class="lb10-hint"
        role="status"
      >
        {{ t('lb10.failures.checking') }}
      </p>
      <p
        v-else-if="refund === 'given'"
        role="status"
        data-testid="refund"
        data-refund="given"
      >
        {{ t('lb10.failures.givenBack') }}
      </p>
      <p
        v-else-if="refund === 'not_given' && isGivenBack(run.failure)"
        role="status"
        data-testid="refund"
        data-refund="not_given"
      >
        {{ t('lb10.failures.notGivenBack') }}
      </p>
    </div>
    <p
      v-if="slow"
      class="lb10-hint"
      role="status"
      data-testid="slow"
    >
      {{ t('lb10.run.slow') }}
    </p>
    <p
      v-if="runMode === 'replay'"
      class="lb10-hint"
      data-testid="replaying-note"
    >
      {{ t('lb10.run.replaying') }}
    </p>
    <p
      v-if="reopened"
      class="lb10-hint"
      data-testid="reopened-note"
    >
      {{ t('lb10.run.reopened') }}
    </p>
    <div
      v-if="following"
      class="actions"
    >
      <div class="lb10-row">
        <button
          type="button"
          class="lb10-button lb10-button--quiet"
          data-testid="stop-waiting"
          @click="store.stopWaiting()"
        >
          {{ t('lb10.run.stopWaiting') }}
        </button>
      </div>
      <p class="lb10-hint">
        {{ t('lb10.run.stopHint') }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.state {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 16px;
  font-weight: 700;
}
.progress {
  display: grid;
  gap: 4px;
}
.failure {
  display: grid;
  gap: 4px;
  padding: 8px 10px;
  background: var(--lb-shade);
  border: 1.5px dashed var(--lb-ink);
}
.failure-title {
  font-weight: 700;
}
.actions {
  display: grid;
  gap: 6px;
}
</style>
