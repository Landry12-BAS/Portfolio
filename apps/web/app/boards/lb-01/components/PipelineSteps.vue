<script setup lang="ts">
// <PipelineSteps>: LB-01's nine pipeline steps in the datasheet's order, each marked done,
// running, waiting, skipped or failed. The state is written in words next to an icon, so it never
// depends on colour. The step names are the datasheet's, in the visitor's language.
import { LbIcon } from '@lb/icons'
import { useI18n } from 'vue-i18n'

import type { StepState } from '../pipeline'

defineProps<{
  /** The steps, in order, each with its name in the visitor's language and its state. */
  steps: readonly { label: string, state: StepState }[]
}>()

const { t } = useI18n()

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
</script>

<template>
  <ol
    class="steps"
    :aria-label="t('lb01.pipeline.label')"
  >
    <li
      v-for="(step, index) in steps"
      :key="index"
      class="step"
      :data-state="step.state"
      data-testid="pipeline-step"
    >
      <LbIcon
        :name="iconFor(step.state)"
        :size="16"
        tone="mono"
      />
      <span class="label">{{ step.label }}</span>
      <span class="state">{{ t(`lb01.pipeline.states.${step.state}`) }}</span>
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
