<script setup lang="ts">
// <StepsPanel>: the nine steps of the datasheet's chain, each with what became of it for this document:
// done, failed, skipped (a repair a clean document did not need, a journal entry a failed check held back),
// not reached (a document that failed stopped before it), and for the last one, export, whether the
// document can be exported or a failed check holds it back. The times and the counts are what the service
// recorded as each step ended (pages and words read, how many segments the injection check read and the
// score it gave, how many model calls the extraction took, which checks failed, how many fields were
// found on the page, how many documents were compared). They are the pipeline's own record, not an
// estimate, and the Scope below shows the same run as a trace.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { formatCount, formatDuration } from '~/board-kit/format'

import type { InvoiceDocument } from '../schemas'
import { chainRows, factsOf, queueStep } from '../steps'

const props = defineProps<{
  /** The document whose run is shown. */
  document: InvoiceDocument
  /** The datasheet's chain in the visitor's language, which names the nine steps. */
  chain: readonly string[]
}>()

const { t, te, locale } = useI18n()

const rows = computed(() => chainRows(props.document))
const waited = computed(() => {
  const waitedMs = queueStep(props.document)?.detail.waited_ms
  return typeof waitedMs === 'number' ? waitedMs : undefined
})

/** Names a fact in the visitor's language; a fact the board has no word for is named as the service names it. */
function factName(key: string): string {
  return te(`lb03.steps.facts.${key}`) ? t(`lb03.steps.facts.${key}`) : key
}

/** Writes a fact's value: durations as times, flags as yes and no, the injection score with two places, other numbers with their separators. */
function factValue(key: string, value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? t('lb03.steps.yes') : t('lb03.steps.no')
  if (typeof value === 'string') return value
  if (key.endsWith('_ms')) return formatDuration(value, locale.value)
  if (key === 'score') return new Intl.NumberFormat(locale.value, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
  return formatCount(value, locale.value)
}
</script>

<template>
  <section
    class="steps"
    :aria-label="t('lb03.steps.title')"
    data-testid="steps"
  >
    <h3 class="lb-label">
      {{ t('lb03.steps.title') }}
    </h3>
    <ol class="list">
      <li
        v-for="row in rows"
        :key="row.index"
        class="step"
        :data-state="row.state"
        data-testid="chain-step"
      >
        <span
          class="index"
          aria-hidden="true"
        >{{ row.index + 1 }}</span>
        <div class="body">
          <p class="head">
            <span class="name">{{ chain[row.index] ?? row.name }}</span>
            <span
              class="state"
              data-testid="chain-state"
            >{{ t(`lb03.steps.states.${row.state}`) }}</span>
            <span
              v-if="row.step && row.step.ms > 0"
              class="time"
            >{{ formatDuration(row.step.ms, locale) }}</span>
          </p>
          <dl
            v-if="row.step && factsOf(row.step).length > 0"
            class="facts"
          >
            <div
              v-for="[key, value] in factsOf(row.step)"
              :key="key"
              class="fact"
            >
              <dt>{{ factName(key) }}</dt>
              <dd>{{ factValue(key, value) }}</dd>
            </div>
          </dl>
        </div>
      </li>
    </ol>
    <p
      v-if="waited !== undefined"
      class="queue"
      data-testid="waited"
    >
      {{ t('lb03.steps.waited', { time: formatDuration(waited, locale) }) }}
    </p>
  </section>
</template>

<style scoped>
.steps {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.list {
  display: grid;
  gap: 0;
  padding: 0;
  margin: 0;
  list-style: none;
}

.step {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px solid var(--lb-rule);
}

.index {
  font-family: var(--lb-font-mono);
  font-size: 12px;
  color: var(--lb-graphite);
}

.body {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.head {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
  align-items: baseline;
}

.name {
  font-size: 14px;
  font-weight: 700;
}

.state {
  font-family: var(--lb-font-mono);
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.step[data-state="notReached"],
.step[data-state="skipped"] {
  color: var(--lb-graphite);
}

.time {
  margin-left: auto;
  font-family: var(--lb-font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 16px;
  margin: 0;
  font-size: 12.5px;
}

.fact {
  display: flex;
  gap: 5px;
}

.fact dt {
  color: var(--lb-graphite);
}

.fact dd {
  margin: 0;
  font-family: var(--lb-font-mono);
  overflow-wrap: anywhere;
}

.queue {
  font-size: 12.5px;
  color: var(--lb-graphite);
}
</style>
