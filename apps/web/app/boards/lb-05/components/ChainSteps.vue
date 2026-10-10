<script setup lang="ts">
// <ChainSteps>: LB-05's seven steps in the datasheet's order, each marked done, running, waiting,
// skipped or stopped, read from the run's trace. The state is written in words next to an icon, so
// it never depends on colour. A step says how many times it ran when the model corrected its query,
// and which layer and rule stopped the query where it did. The names are the datasheet's, in the
// visitor's language; the layer and rule are named from the locale files, not from the trace.
import { LbIcon } from '@lb/icons'
import { useI18n } from 'vue-i18n'

import { formatCount } from '~/board-kit/format'

import type { PipelineStep, StepState } from '../pipeline'
import { SQL_LAYERS, SQL_RULES } from '#shared/data/sql-safety'
import type { SqlLayer, SqlRule } from '#shared/data/sql-safety'

defineProps<{
  /** The steps, in order. */
  steps: readonly PipelineStep[]
  /** The names of the steps in the visitor's language, in the same order. */
  labels: readonly string[]
  /** True when the trace has not arrived, so no step may be called running, done or skipped. */
  blind: boolean
}>()

const { t, locale } = useI18n()

/** Picks the icon for a step's state. */
function iconFor(state: StepState): 'success' | 'play' | 'clock' | 'close' | 'error' {
  switch (state) {
    case 'done': return 'success'
    case 'running': return 'play'
    case 'waiting': return 'clock'
    case 'skipped': return 'close'
    default: return 'error'
  }
}

/** Tells whether a text from a trace names a layer. */
function isLayer(value: string | undefined): value is SqlLayer {
  return SQL_LAYERS.some(layer => layer === value)
}

/** Tells whether a text from a trace names a rule. */
function isRule(value: string | undefined): value is SqlRule {
  return SQL_RULES.some(rule => rule === value)
}

/** Writes what a step adds to its state: that it ran more than once, or which layer and rule stopped it or sent it back. */
function detail(step: PipelineStep): string {
  if (step.state === 'failed' && isLayer(step.layer) && isRule(step.rule)) {
    return t('lb05.steps.stoppedBy', { layer: t(`lb05.layers.items.${step.layer}.name`), rule: t(`lb05.rules.${step.rule}`) })
  }
  if (step.index === 5 && step.state === 'done' && isLayer(step.layer) && isRule(step.rule)) {
    return t('lb05.steps.after', { layer: t(`lb05.layers.items.${step.layer}.name`), rule: t(`lb05.rules.${step.rule}`) })
  }
  return step.runs > 1 ? t('lb05.steps.ranTimes', { count: formatCount(step.runs, locale.value) }) : ''
}
</script>

<template>
  <ol
    class="steps"
    :aria-label="t('lb05.steps.label')"
  >
    <li
      v-for="step in steps"
      :key="step.index"
      class="step"
      :data-state="blind ? 'waiting' : step.state"
      data-testid="chain-step"
    >
      <LbIcon
        :name="iconFor(blind ? 'waiting' : step.state)"
        :size="16"
        tone="mono"
      />
      <span class="label">
        {{ labels[step.index] }}
        <span
          v-if="!blind && detail(step)"
          class="detail"
        >{{ detail(step) }}</span>
      </span>
      <span class="state">{{ t(`lb05.steps.states.${blind ? 'waiting' : step.state}`) }}</span>
    </li>
  </ol>
</template>

<style scoped>
.steps {
  display: grid;
  gap: 0;
  padding: 0;
  margin: 0;
  list-style: none;
  counter-reset: step;
  border: 1px solid var(--lb-rule);
}

.step {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 6px 10px;
  font-size: 13.5px;
  border-bottom: 1px solid var(--lb-rule);
  counter-increment: step;
}

.step:last-child {
  border-bottom: 0;
}

.label::before {
  margin-right: 8px;
  font-family: var(--lb-font-mono);
  font-size: 10.5px;
  color: var(--lb-graphite);
  content: counter(step, decimal-leading-zero);
}

.detail {
  display: block;
  margin-left: 26px;
  font-size: 12px;
  color: var(--lb-graphite);
}

.state {
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.step[data-state="running"] {
  background: var(--lb-board-tint);
}

.step[data-state="running"] .state,
.step[data-state="failed"] .state {
  font-weight: 700;
  color: var(--lb-ink);
}

.step[data-state="skipped"] .label {
  color: var(--lb-graphite);
  text-decoration: line-through;
}
</style>
