<script setup lang="ts">
// <DatasheetRunFigure>: a datasheet's first figure, the time each step of the signal chain took in one
// recorded run. One row per step, in the chain's order, with a bar drawn against the longest step in the
// Scope's channel colours (model, tool, retrieval, guard; a plain step in ink) and the time in words next
// to it. The bars are decoration: the names and times are text, so the figure reads without them. The
// bars grow in once, left to right, one after the other, and nothing fades.
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'

import type { HeroTrace } from '#shared/data/hero-trace'

const props = defineProps<{
  /** The recorded run, reduced to its steps. */
  trace: HeroTrace
  /** The sample's title in the visitor's language, for the caption. */
  sampleTitle: string
  /** The chain's step names in the visitor's language, in the trace's order; the trace's own names otherwise. */
  labels?: readonly string[]
}>()

const { t } = useI18n()
const { duration, count, day } = useDatasheetFormat()
const titleId = useId()

const longest = computed(() => Math.max(1, ...props.trace.steps.map(step => step.endMs - step.startMs)))

const rows = computed(() => props.trace.steps.map((step, index) => {
  const ms = step.endMs - step.startMs
  return {
    name: props.labels?.length === props.trace.steps.length ? props.labels[index] ?? step.name : step.name,
    kind: step.kind,
    ms,
    // An instant step gets a hairline, so the row still shows where its bar would start.
    width: ms < 10 ? 0 : (ms / longest.value) * 100,
  }
}))

const seconds = computed(() => count(Math.round(props.trace.totalMs / 100) / 10))
const kinds = ['model', 'tool', 'retrieval', 'guard'] as const
</script>

<template>
  <figure
    class="fig"
    :aria-labelledby="titleId"
  >
    <figcaption class="cap">
      <span
        :id="titleId"
        class="cap-title"
      >{{ t('datasheet.figure.title') }}</span>
      <span class="cap-text">{{ t('datasheet.figure.caption', { sample: sampleTitle, steps: trace.steps.length, seconds, date: day(trace.recordedAt) }) }}</span>
    </figcaption>
    <ol class="rows">
      <li
        v-for="(row, index) in rows"
        :key="`${index}-${row.name}`"
        class="row"
        :data-kind="row.kind"
        :style="{ '--i': index }"
      >
        <span class="n">{{ String(index + 1).padStart(2, '0') }}</span>
        <span class="name">{{ row.name }}</span>
        <span
          class="track"
          aria-hidden="true"
        >
          <span
            class="bar"
            :class="{ instant: row.width === 0 }"
            :style="{ width: row.width === 0 ? undefined : `${row.width}%` }"
          />
        </span>
        <span class="time">{{ duration(row.ms) }}</span>
      </li>
    </ol>
    <ul
      class="legend"
      :aria-label="t('datasheet.figure.legend')"
    >
      <li
        v-for="kind in kinds"
        :key="kind"
        :data-kind="kind"
      >
        {{ t(`home.hero.scope.legend.${kind}`) }}
      </li>
    </ul>
  </figure>
</template>

<style scoped>
.fig {
  display: grid;
  gap: 10px;
  margin: 0;
}

.cap {
  display: grid;
  gap: 3px;
}

.cap-title {
  font-family: var(--lb-font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.cap-text {
  font-size: 13px;
  color: var(--lb-graphite);
}

.rows {
  display: grid;
  padding: 0;
  margin: 0;
  list-style: none;
  border-top: 1px solid var(--lb-rule);
}

.row {
  display: grid;
  grid-template-columns: 2ch minmax(0, 11rem) minmax(0, 1fr) 6.5ch;
  gap: 10px;
  align-items: center;
  min-height: 30px;
  padding: 3px 0;
  border-bottom: 1px solid var(--lb-rule);
}

.n,
.time {
  font-family: var(--lb-font-mono);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--lb-graphite);
}

.time {
  text-align: right;
  white-space: nowrap;
}

.name {
  overflow: hidden;
  font-size: 13.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track {
  position: relative;
  display: block;
  height: 14px;
}

.bar {
  position: absolute;
  inset: 0 auto 0 0;
  min-width: 2px;
  background: var(--lb-ink);
  border-radius: 1px;
  transform-origin: left center;
  animation: grow var(--lb-motion-enter) var(--lb-ease) both;
  animation-delay: calc(80ms + var(--i, 0) * 40ms);
}

.bar.instant {
  width: 2px;
  background: var(--lb-graphite);
}

.row[data-kind="model"] .bar { background: var(--lb-ch1); }
.row[data-kind="tool"] .bar { background: var(--lb-ch2); }
.row[data-kind="retrieval"] .bar { background: var(--lb-ch3); }
.row[data-kind="guard"] .bar { background: var(--lb-ch4); }

@keyframes grow {
  from { transform: scaleX(0); }
  to { transform: none; }
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  padding: 0;
  margin: 0;
  list-style: none;
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.legend li {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

.legend li::before {
  width: 10px;
  height: 10px;
  content: "";
  border-radius: 1px;
}

.legend [data-kind="model"]::before { background: var(--lb-ch1); }
.legend [data-kind="tool"]::before { background: var(--lb-ch2); }
.legend [data-kind="retrieval"]::before { background: var(--lb-ch3); }
.legend [data-kind="guard"]::before { background: var(--lb-ch4); }

@media (max-width: 480px) {
  .row {
    grid-template-columns: 2ch minmax(0, 1fr) 6.5ch;
    grid-template-areas:
      "n name time"
      "n track track";
    row-gap: 4px;
  }

  .n { grid-area: n; }
  .name { grid-area: name; }
  .track { grid-area: track; height: 8px; }
  .time { grid-area: time; }
}
</style>
