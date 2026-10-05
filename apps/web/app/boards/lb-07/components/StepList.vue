<script setup lang="ts">
// <StepList>: the steps of the run as they happen, grouped by the plan they came from: the first plan, and
// a re-plan for each step that failed, introduced by the step whose failure asked for it. Each step is said
// in words (the plan's own words, a path, a button's name or a text to expect, quoted as data), with what
// became of it as a word and an icon; the Technical reading adds how long it took and, for a step that did
// not pass, why, in the service's stable terms said in words.
import { LbIcon } from '@lb/icons'
import type { IconName } from '@lb/icons'
import type { Lb07StepStatus } from '@lb/contracts'
import { storeToRefs } from 'pinia'
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { planGroups } from '../run'
import { useLb07Store } from '../store'
import { useLb07Words } from '../words'

defineProps<{
  /** The Brief reading leaves out each step's time and outcome. */
  brief: boolean
}>()

const { t } = useI18n()
const words = useLb07Words()
const { run } = storeToRefs(useLb07Store())
const id = useId()

const ICONS: Readonly<Record<Lb07StepStatus, IconName>> = { pending: 'clock', running: 'live', passed: 'check', failed: 'error', finding: 'warning', blocked: 'shield', skipped: 'close' }

const groups = computed(() => planGroups(run.value?.steps ?? []))
</script>

<template>
  <section
    v-if="run"
    class="lb7-panel"
    :aria-labelledby="`${id}-title`"
    data-testid="steps"
  >
    <h2 :id="`${id}-title`">
      {{ t('lb07.steps.title') }}
    </h2>
    <p
      v-if="groups.length === 0"
      class="lb7-hint"
    >
      {{ t('lb07.steps.empty') }}
    </p>
    <div
      v-for="group in groups"
      :key="group.plan"
      class="plan"
      :data-plan="group.plan"
      data-testid="plan"
    >
      <h3 class="plan-title">
        {{ group.plan === 0 ? t('lb07.steps.firstPlan') : t('lb07.steps.replan', { number: group.plan }) }}
      </h3>
      <p
        v-if="group.after !== null"
        class="lb7-hint"
        data-testid="replan-intro"
      >
        {{ t('lb07.steps.replanIntro', { number: group.after }) }}
      </p>
      <ul class="steps">
        <li
          v-for="step in group.steps"
          :key="step.index"
          class="step"
          :data-status="step.status"
          data-testid="step"
        >
          <span class="number lb7-nums">{{ t('lb07.steps.stepNumber', { number: step.index + 1 }) }}</span>
          <span class="what">{{ words.stepText(step.step) }}</span>
          <span class="lb7-status status">
            <LbIcon
              :name="ICONS[step.status]"
              :size="14"
              tone="mono"
            />
            {{ words.statusWord(step.status) }}
          </span>
          <span
            v-if="!brief && (step.durationMs !== null || (step.outcome !== null && step.outcome !== 'ok'))"
            class="detail lb7-hint"
          >
            <span v-if="step.durationMs !== null">{{ t('lb07.steps.took', { time: words.duration(step.durationMs) }) }}</span>
            <span v-if="step.outcome !== null && step.outcome !== 'ok'">{{ t('lb07.steps.outcome', { outcome: words.outcomeWord(step.outcome) }) }}</span>
          </span>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.plan {
  display: grid;
  gap: 6px;
}
.plan + .plan {
  padding-top: 8px;
  border-top: 1px dashed var(--lb-rule);
}
.plan-title {
  font-size: 13px;
  font-weight: 700;
}
.steps {
  display: grid;
  gap: 0;
  padding: 0;
  margin: 0;
  list-style: none;
}
.step {
  display: grid;
  grid-template-columns: minmax(64px, auto) minmax(0, 1fr) auto;
  gap: 2px 12px;
  align-items: baseline;
  padding: 6px 0;
  font-size: 13.5px;
  border-bottom: 1px solid var(--lb-rule);
}
.number {
  font-family: var(--lb-font-mono);
  font-size: 11px;
  color: var(--lb-graphite);
}
.what {
  min-width: 0;
  overflow-wrap: anywhere;
}
.status {
  font-size: 12.5px;
  white-space: nowrap;
}
.detail {
  display: flex;
  flex-wrap: wrap;
  grid-column: 2 / -1;
  gap: 2px 12px;
}
.step[data-status="skipped"] .what,
.step[data-status="pending"] .what {
  color: var(--lb-graphite);
}
@media (width <= 520px) {
  .step {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .number {
    grid-column: 1 / -1;
  }
  .detail {
    grid-column: 1 / -1;
  }
}
</style>
