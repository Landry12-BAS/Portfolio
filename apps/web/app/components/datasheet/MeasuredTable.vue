<script setup lang="ts">
// <DatasheetMeasuredTable>: a datasheet's second table, the characteristics measured on each curated
// sample's recording: steps taken, calls through the gateway, tokens in and out, the run's time and how it
// ended. The figures are the recordings' (shared/data/measured.ts), and the note under the table says
// where and when they were measured, as a datasheet states its test conditions.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { MeasuredRun } from '#shared/data/measured'
import { recordedDayOf } from '#shared/data/measured'

import { useDatasheetFormat } from '~/composables/useDatasheetFormat'

const props = defineProps<{
  /** The rows, one per curated sample. */
  rows: readonly MeasuredRun[]
  /** The key the system's board strings live under, such as `lb01`, where each sample's title is. */
  systemKey: string
}>()

const { t, te } = useI18n()
const { duration, count, day } = useDatasheetFormat()

const sharedDay = computed(() => recordedDayOf(props.rows))

/** The sample's title in the visitor's language, or its id where the board has no title for it. */
function titleOf(sample: string): string {
  const key = `${props.systemKey}.samples.${sample}.title`
  return te(key) ? t(key) : sample
}

/** How a run ended, in words: a draft for a person, or handed over with the reason in the visitor's language. */
function outcomeOf(row: MeasuredRun): string {
  if (row.outcome === 'draft') return t('datasheet.measured.draft')
  const reasonKey = `datasheet.measured.reasons.${row.reason ?? ''}`
  return t('datasheet.measured.escalated', { reason: row.reason && te(reasonKey) ? t(reasonKey) : (row.reason ?? '') })
}
</script>

<template>
  <div class="measured">
    <div class="sheet">
      <table>
        <caption>{{ t('datasheet.measured.title') }}</caption>
        <thead>
          <tr>
            <th scope="col">
              {{ t('datasheet.measured.sample') }}
            </th>
            <th scope="col">
              {{ t('datasheet.measured.language') }}
            </th>
            <th
              scope="col"
              class="num"
            >
              {{ t('datasheet.measured.steps') }}
            </th>
            <th
              scope="col"
              class="num"
            >
              {{ t('datasheet.measured.calls') }}
            </th>
            <th
              scope="col"
              class="num"
            >
              {{ t('datasheet.measured.tokens') }}
            </th>
            <th
              scope="col"
              class="num"
            >
              {{ t('datasheet.measured.time') }}
            </th>
            <th scope="col">
              {{ t('datasheet.measured.outcome') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.sample"
            :data-outcome="row.outcome"
          >
            <th scope="row">
              {{ titleOf(row.sample) }}
              <span
                v-if="!sharedDay"
                class="when"
              >{{ day(row.recordedAt) }}</span>
            </th>
            <td>{{ t(`datasheet.measured.languages.${row.language}`) }}</td>
            <td class="num">
              {{ row.steps }}
            </td>
            <td class="num">
              {{ row.calls }}
            </td>
            <td class="num">
              {{ count(row.tokensIn) }} / {{ count(row.tokensOut) }}
            </td>
            <td class="num">
              {{ duration(row.durationMs) }}
            </td>
            <td class="outcome">
              {{ outcomeOf(row) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="note">
      {{ sharedDay ? t('datasheet.measured.note', { date: day(sharedDay) }) : t('datasheet.measured.noteMixed') }}
    </p>
  </div>
</template>

<style scoped>
.measured {
  display: grid;
  gap: 8px;
}

/* On a narrow screen the table scrolls sideways on its own; the note under it stays put. */
.sheet {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  line-height: 1.35;
}

caption {
  padding-bottom: 6px;
  font-family: var(--lb-font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-align: left;
  text-transform: uppercase;
  caption-side: top;
  color: var(--lb-graphite);
}

thead th {
  padding: 7px 8px;
  font-family: var(--lb-font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-align: left;
  text-transform: uppercase;
  vertical-align: bottom;
  background: var(--lb-shade);
  border-bottom: 1.5px solid var(--lb-ink);
}

tbody th,
tbody td {
  padding: 7px 8px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--lb-rule);
}

tbody th {
  font-weight: 600;
  white-space: nowrap;
}

.when {
  display: block;
  font-family: var(--lb-font-mono);
  font-size: 10px;
  font-weight: 400;
  color: var(--lb-graphite);
}

.num {
  font-family: var(--lb-font-mono);
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}

/* One line per sample: on a narrow screen the table scrolls sideways rather than growing tall. */
.outcome {
  white-space: nowrap;
}

/* The one run a person had to take over is the row to notice: its outcome is set in ink and bold. */
tr[data-outcome="escalated"] .outcome {
  font-weight: 700;
}

.note {
  max-width: 72ch;
  font-size: 12.5px;
  color: var(--lb-graphite);
}
</style>
