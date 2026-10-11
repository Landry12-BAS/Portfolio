<script setup lang="ts">
// <PipelineSteps>: LB-01's nine pipeline steps in the datasheet's order, each marked done,
// running, waiting, skipped or failed. The state is written in words next to an icon, so it never
// depends on colour. A finished step shows how long it took and takes the colour of the Scope's
// channel its call belonged to, the same colours as the datasheet's figure and the landing page's
// trace, so the run reads the same wherever it is drawn. The step names are the datasheet's, in the
// visitor's language.
import { LbIcon } from '@lb/icons'
import { useI18n } from 'vue-i18n'

import type { HeroStepKind } from '#shared/data/hero-trace'

import type { StepState } from '../pipeline'

defineProps<{
  /** The steps, in order, each with its name in the visitor's language, its state, its channel and its time once known. */
  steps: readonly { label: string, state: StepState, kind: HeroStepKind, durationMs?: number }[]
}>()

const { t } = useI18n()
const { duration } = useDatasheetFormat()

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
      :data-kind="step.kind"
      data-testid="pipeline-step"
    >
      <span
        class="channel"
        aria-hidden="true"
      />
      <LbIcon
        :name="iconFor(step.state)"
        :size="16"
        tone="mono"
      />
      <span class="label">{{ step.label }}</span>
      <span
        v-if="step.durationMs !== undefined && step.state !== 'skipped'"
        class="time"
      >{{ duration(step.durationMs) }}</span>
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
  grid-template-columns: 4px auto minmax(0, 1fr) auto auto;
  gap: 10px;
  align-items: center;
  padding: 6px 10px 6px 0;
  font-size: 13.5px;
  border-bottom: 1px solid var(--lb-rule);
  counter-increment: step;
}

.step:last-child {
  border-bottom: 0;
}

/* The channel runs down the left edge of the row, blank until the step's call is known. */
.channel {
  align-self: stretch;
  background: transparent;
  transition: background var(--lb-motion-fast) var(--lb-ease);
}

.step[data-state="done"] .channel,
.step[data-state="failed"] .channel {
  background: var(--lb-ink);
}

.step[data-kind="model"][data-state="done"] .channel { background: var(--lb-ch1); }
.step[data-kind="tool"][data-state="done"] .channel { background: var(--lb-ch2); }
.step[data-kind="retrieval"][data-state="done"] .channel { background: var(--lb-ch3); }
.step[data-kind="guard"][data-state="done"] .channel { background: var(--lb-ch4); }

.label::before {
  margin-right: 8px;
  font-family: var(--lb-font-mono);
  font-size: 10.5px;
  color: var(--lb-graphite);
  content: counter(step, decimal-leading-zero);
}

.time,
.state {
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--lb-graphite);
}

.time {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.state {
  text-transform: uppercase;
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
