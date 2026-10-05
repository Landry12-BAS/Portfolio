<script setup lang="ts">
// <RunPanel>: where the run stands, said plainly. Its state in words with an icon (never by colour alone)
// and the stepper of its stages, the place in the queue while it waits ("2 runs are ahead of yours"), the
// counters the service keeps (model calls of the eight a run may make, re-plans of the two, the time in the
// browser, the findings), the goal and the bugs as they were given, shown back as text, and the planner's
// one sentence on how it read the goal, labelled as a model's words. It holds the two buttons that act on
// the whole run: stop waiting while it goes, and delete it once it has ended.
import { LB07_LIMITS } from '@lb/contracts'
import { LbIcon } from '@lb/icons'
import type { IconName } from '@lb/icons'
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatMoment } from '~/board-kit/format'
import { SLOW_AFTER_MS } from '../pace'
import { secondsRun, skipsChecks, stepperOf } from '../run'
import type { StageStatus } from '../run'
import { useLb07Store } from '../store'
import { useLb07Words } from '../words'

defineProps<{
  /** The Brief reading leaves out the cap's explanation and the time a run is kept. */
  brief: boolean
}>()

const { t, locale } = useI18n()
const words = useLb07Words()
const store = useLb07Store()
const { run, report, runMode, phase, followedSince, deleting, actionProblem } = storeToRefs(store)
const id = useId()

// The clock the time in the browser is counted on, moved once a second while the board is open.
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

const ICONS: Readonly<Record<StageStatus, IconName>> = { done: 'check', current: 'live', waiting: 'clock', failed: 'error', skipped: 'close' }

const stepper = computed(() => (run.value ? stepperOf(run.value, report.value) : []))
const finishing = computed(() => run.value?.state === 'verifying' && skipsChecks(run.value, report.value))
const headline = computed(() => (finishing.value ? t('lb07.run.finishing') : words.stateWord(run.value?.state ?? 'queued')))
const icon = computed<IconName>(() => {
  switch (run.value?.state) {
    case 'done': return 'success'
    case 'failed': return 'error'
    case 'queued': return 'clock'
    default: return 'live'
  }
})
const seconds = computed(() => (run.value ? secondsRun(run.value, Math.max(now.value, Date.now())) : undefined))
const slow = computed(() => runMode.value === 'live' && phase.value === 'following' && followedSince.value !== undefined && now.value - followedSince.value > SLOW_AFTER_MS)
const following = computed(() => runMode.value === 'live' && (phase.value === 'following' || phase.value === 'starting'))
</script>

<template>
  <section
    v-if="run"
    class="lb7-panel bar"
    :aria-labelledby="`${id}-title`"
    data-testid="run-panel"
  >
    <h2 :id="`${id}-title`">
      {{ t('lb07.run.title') }}
    </h2>
    <p
      class="state"
      role="status"
      data-testid="run-state"
      :data-state="run.state"
    >
      <LbIcon
        :name="icon"
        :size="20"
        tone="mono"
      />
      <span>{{ headline }}</span>
    </p>
    <ol
      class="stepper"
      :aria-label="t('lb07.stepper.label')"
      data-testid="stepper"
    >
      <li
        v-for="item in stepper"
        :key="item.stage"
        :class="`stage stage--${item.status}`"
        :aria-current="item.status === 'current' ? 'step' : undefined"
        :data-stage="item.stage"
        :data-status="item.status"
      >
        <LbIcon
          :name="ICONS[item.status]"
          :size="14"
          tone="mono"
        />
        <span class="stage-name">{{ t(`lb07.stepper.stages.${item.stage}`) }}</span>
        <span class="stage-status">{{ t(`lb07.stepper.status.${item.status}`) }}</span>
      </li>
    </ol>
    <div
      v-if="run.state === 'queued'"
      class="queue"
      data-testid="queue"
    >
      <p class="queue-place">
        {{ words.queueText(run.queuePosition ?? 0) }}
      </p>
      <p class="lb7-hint">
        {{ t('lb07.queue.note') }}
      </p>
    </div>
    <dl
      class="lb7-facts"
      :aria-label="t('lb07.counters.label')"
    >
      <div>
        <dt>{{ t('lb07.counters.calls') }}</dt>
        <dd data-testid="model-calls">
          {{ t('lb07.counters.valueOf', { used: run.modelCalls, max: LB07_LIMITS.maxModelCalls }) }}
        </dd>
      </div>
      <div>
        <dt>{{ t('lb07.counters.replans') }}</dt>
        <dd data-testid="replans">
          {{ t('lb07.counters.valueOf', { used: run.replans, max: LB07_LIMITS.maxReplans }) }}
        </dd>
      </div>
      <div>
        <dt>{{ run.endedAt === null ? t('lb07.counters.time') : t('lb07.counters.timeDone') }}</dt>
        <dd data-testid="run-time">
          {{ seconds === undefined ? '–' : words.clock(seconds) }}
        </dd>
      </div>
      <div>
        <dt>{{ t('lb07.counters.findings') }}</dt>
        <dd data-testid="findings-count">
          {{ run.findings }}
        </dd>
      </div>
    </dl>
    <p
      v-if="!brief"
      class="lb7-hint"
    >
      {{ t('lb07.counters.callsNote', { max: LB07_LIMITS.maxModelCalls }) }}
    </p>
    <div class="given">
      <div class="given-part">
        <p class="lb7-label">
          {{ run.origin === 'sample' ? t('lb07.run.goal') : t('lb07.run.yourGoal') }}
          <span class="lb7-chip">{{ t(`lb07.run.origin.${run.origin}`) }}</span>
        </p>
        <blockquote
          class="lb7-quote"
          :lang="run.origin === 'sample' ? 'en' : undefined"
          data-testid="run-goal"
        >
          {{ run.goal }}
        </blockquote>
      </div>
      <div class="given-part">
        <p class="lb7-label">
          {{ t('lb07.run.bugs') }}
        </p>
        <ul
          v-if="run.bugs.length > 0"
          class="lb7-chips"
          data-testid="run-bugs"
        >
          <li
            v-for="bug in run.bugs"
            :key="bug"
            class="lb7-chip"
          >
            {{ words.bugTitle(bug) }}
          </li>
        </ul>
        <p
          v-else
          class="lb7-hint"
          data-testid="run-bugs"
        >
          {{ t('lb07.start.noBugs') }}
        </p>
      </div>
    </div>
    <div
      v-if="run.reading"
      class="reading"
      data-testid="reading"
    >
      <p class="lb7-label">
        {{ t('lb07.run.reading') }}
      </p>
      <blockquote
        class="lb7-quote"
        lang="en"
      >
        {{ run.reading }}
      </blockquote>
      <p class="lb7-hint">
        {{ t('lb07.run.readingBy') }}
      </p>
    </div>
    <p
      v-if="slow"
      class="lb7-hint"
      role="status"
      data-testid="slow"
    >
      {{ t('lb07.run.slow') }}
    </p>
    <p
      v-if="runMode === 'replay'"
      class="lb7-hint"
      data-testid="replaying-note"
    >
      {{ t('lb07.run.replaying') }}
    </p>
    <div
      v-if="runMode === 'live'"
      class="actions"
    >
      <div class="lb7-row">
        <button
          v-if="following"
          type="button"
          class="lb7-button lb7-button--quiet"
          data-testid="stop-waiting"
          @click="store.stopWaiting()"
        >
          {{ t('lb07.run.stopWaiting') }}
        </button>
        <button
          v-else
          type="button"
          class="lb7-button lb7-button--quiet"
          :disabled="deleting"
          data-testid="delete-run"
          @click="store.deleteRun()"
        >
          {{ deleting ? t('lb07.run.deleting') : t('lb07.run.delete') }}
        </button>
      </div>
      <p class="lb7-hint">
        {{ following ? t('lb07.run.stopHint') : t('lb07.run.deleteHint') }}
      </p>
      <p
        v-if="!brief"
        class="lb7-hint"
        data-testid="kept-until"
      >
        {{ t('lb07.run.kept', { time: formatMoment(run.expiresAt, locale) }) }}
      </p>
      <BoardNotice
        v-if="actionProblem"
        :kind="actionProblem.kind"
      />
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
.stepper {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.stage {
  display: inline-grid;
  grid-template-columns: auto auto;
  gap: 0 6px;
  align-items: center;
  padding: 5px 9px;
  font-size: 12.5px;
  border: 1px solid var(--lb-rule);
  border-radius: 4px;
}
.stage-name {
  font-weight: 600;
}
.stage-status {
  grid-column: 2;
  font-size: 11px;
  color: var(--lb-graphite);
}
.stage--current {
  border-color: var(--lb-ink);
  border-width: 2px;
}
.stage--done,
.stage--failed {
  border-color: var(--lb-ink);
}
.stage--skipped .stage-name,
.stage--waiting .stage-name {
  font-weight: 400;
}
.queue {
  display: grid;
  gap: 4px;
  padding: 8px 10px;
  background: var(--lb-shade);
}
.queue-place {
  font-weight: 700;
}
.given {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
  gap: 12px 20px;
}
.given-part,
.reading {
  display: grid;
  gap: 6px;
  align-content: start;
  min-width: 0;
}
.given-part .lb7-label {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.actions {
  display: grid;
  gap: 6px;
}
</style>
