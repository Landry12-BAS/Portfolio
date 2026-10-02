<script setup lang="ts">
// <ResultTable>: the table a query returned, with what a visitor needs to judge it: how many rows and
// columns, whether the row cap cut it (and at how many rows), how long the query took against the
// limit, and the kind of value in each column. It shows fifty rows and adds fifty more on request, or
// all of them, so a result of hundreds of rows stays quick to scan and to move through; the table
// scrolls inside a region the keyboard can reach. Every cell is data from the warehouse and is shown
// as text, numbers in the visitor's language, and nothing in it is read as markup.
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { formatCount, formatDuration } from '~/board-kit/format'

import type { Limits, QueryResult } from '../schemas'
import { formatCell, isNumeric, nextShown, ROWS_PER_PAGE, rowsToShow } from '../table'

const props = defineProps<{
  result: QueryResult
  /** The limits the back end enforces, which the statements about the cut and the timeout quote. */
  limits: Limits
}>()

const { t, locale } = useI18n()

const shown = ref(ROWS_PER_PAGE)
const region = ref<HTMLElement>()
// A new result starts again at the first page.
watch(() => props.result, () => {
  shown.value = ROWS_PER_PAGE
})

const words = computed(() => ({ empty: t('lb05.result.noValue'), yes: t('lb05.result.yes'), no: t('lb05.result.no') }))
const visible = computed(() => rowsToShow(props.result.rows, shown.value))
const total = computed(() => props.result.rows.length)
const hasMore = computed(() => shown.value < total.value)

/** Writes a cell in the visitor's language. */
function write(columnIndex: number, row: readonly (string | number | boolean | null)[]): string {
  const cell = row[columnIndex]
  const kind = props.result.columns[columnIndex]?.kind ?? 'other'
  return formatCell(cell ?? null, kind, locale.value, words.value)
}

/** Hands the keyboard to the table once the last rows are in, since the buttons that asked for them are gone by then. */
async function keepFocus(): Promise<void> {
  await nextTick()
  if (!hasMore.value) region.value?.focus({ preventScroll: true })
}

/** Shows one more page of rows. */
async function showMore(): Promise<void> {
  shown.value = nextShown(shown.value, total.value)
  await keepFocus()
}

/** Shows every row. */
async function showAll(): Promise<void> {
  shown.value = total.value
  await keepFocus()
}
</script>

<template>
  <div
    class="result"
    data-testid="result"
  >
    <p
      class="facts"
      data-testid="result-facts"
    >
      {{ t('lb05.result.rowsAndColumns', { rows: formatCount(total, locale), columns: formatCount(result.columns.length, locale) }) }}
    </p>
    <p
      class="statement"
      :data-cut="result.truncated"
      data-testid="result-cut"
    >
      {{ result.truncated ? t('lb05.result.cut', { cap: formatCount(limits.row_cap, locale) }) : t('lb05.result.notCut') }}
    </p>
    <p class="statement">
      {{ t('lb05.result.timing', { time: formatDuration(result.elapsed_ms, locale), seconds: formatCount(limits.query_timeout_seconds, locale) }) }}
    </p>

    <p
      v-if="total === 0"
      class="statement"
    >
      {{ t('lb05.result.empty') }}
    </p>
    <div
      v-else
      ref="region"
      class="scroll"
      role="region"
      tabindex="0"
      :aria-label="t('lb05.result.scroll')"
    >
      <table data-testid="result-table">
        <caption class="lb-sr-only">
          {{ t('lb05.result.caption') }}
        </caption>
        <thead>
          <tr>
            <th
              v-for="column in result.columns"
              :key="column.name"
              scope="col"
              :class="{ number: isNumeric(column.kind) }"
            >
              <span class="name">{{ column.name }}</span>
              <span class="kind">{{ t(`lb05.result.kinds.${column.kind}`) }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, rowIndex) in visible"
            :key="rowIndex"
            data-testid="result-row"
          >
            <td
              v-for="(column, columnIndex) in result.columns"
              :key="column.name"
              :class="{ number: isNumeric(column.kind), empty: row[columnIndex] === null }"
            >
              {{ write(columnIndex, row) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div
      v-if="total > ROWS_PER_PAGE"
      class="more"
    >
      <p
        class="statement"
        role="status"
        data-testid="result-shown"
      >
        {{ t('lb05.result.shown', { shown: formatCount(visible.length, locale), total: formatCount(total, locale) }) }}
      </p>
      <div
        v-if="hasMore"
        class="buttons"
      >
        <button
          type="button"
          class="button"
          data-testid="show-more"
          @click="showMore"
        >
          {{ t('lb05.result.showMore') }}
        </button>
        <button
          type="button"
          class="button"
          data-testid="show-all"
          @click="showAll"
        >
          {{ t('lb05.result.showAll') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.result {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.facts {
  font-family: var(--lb-font-mono);
  font-size: 12.5px;
}

.statement {
  font-size: 13px;
  color: var(--lb-graphite);
}

.statement[data-cut="true"] {
  font-weight: 700;
  color: var(--lb-ink);
}

.scroll {
  max-height: 440px;
  overflow: auto;
  border: 1px solid var(--lb-rule);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

th,
td {
  padding: 6px 10px;
  text-align: left;
  white-space: nowrap;
  border-bottom: 1px solid var(--lb-rule);
}

thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--lb-shade);
  border-bottom: 1.5px solid var(--lb-ink);
}

.name {
  display: block;
  font-family: var(--lb-font-mono);
  font-size: 12px;
  font-weight: 700;
}

.kind {
  display: block;
  font-size: 11px;
  font-weight: 400;
  color: var(--lb-graphite);
}

.number {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

td {
  font-family: var(--lb-font-mono);
  font-size: 12.5px;
}

td.empty {
  font-style: italic;
  color: var(--lb-graphite);
}

.more {
  display: grid;
  gap: 6px;
}

.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.button {
  padding: 7px 14px;
  font: 600 13px/1 var(--lb-font-sans);
  color: var(--lb-ink);
  cursor: pointer;
  background: transparent;
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}

.button:hover {
  background: var(--lb-shade);
}
</style>
