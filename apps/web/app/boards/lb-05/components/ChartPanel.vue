<script setup lang="ts">
// <ChartPanel>: the chart the back end built for a result, drawn in the browser. The spec is first held
// to the strict subset of Vega-Lite the back end writes (chart/spec.ts); a spec that is anything else is
// refused and the table is left to speak. A chart that passes is drawn on a canvas by Vega, which is
// loaded only now (the first time a chart is shown on the page), in the design tokens' colours, and
// drawn again when the theme or the width changes. Every chart has a text alternative (what it is,
// how many points, which is highest and lowest) and a table of the points it draws, because a
// drawing alone is not enough to read it by. Nothing here builds markup from the spec.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { formatCount } from '~/board-kit/format'

import { chartFacts, chartRows } from '../chart/facts'
import type { ChartRow } from '../chart/facts'
import type { DrawnChart } from '../chart/render'
import { checkChart } from '../chart/spec'
import { readChartTokens } from '../chart/theme'
import type { ChartEnvelope } from '../schemas'
import { formatNumber } from '../table'

const props = defineProps<{
  /** The chart the answer carries, or null when the result had no honest chart. */
  chart: ChartEnvelope | null
}>()

const { t, locale } = useI18n()

const container = ref<HTMLElement>()
const status = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')
const showTable = ref(false)
// A chart on the page, and which drawing is the current one: a newer drawing makes an older one stop.
let drawn: DrawnChart | undefined
let drawing = 0
let drawnWidth = 0
let themeWatcher: MutationObserver | undefined
let sizeWatcher: ResizeObserver | undefined

const checked = computed(() => (props.chart ? checkChart(props.chart) : undefined))
const spec = computed(() => (checked.value?.ok ? checked.value.spec : undefined))
const facts = computed(() => (spec.value ? chartFacts(spec.value) : undefined))
const rows = computed(() => (spec.value ? chartRows(spec.value) : []))
const refusal = computed(() => (checked.value && !checked.value.ok ? checked.value.reason : undefined))
const seriesTitle = computed(() => facts.value?.seriesTitle)

/** Writes a point's value in the visitor's language. */
function value(row: ChartRow): string {
  return typeof row.y === 'number' ? formatNumber(row.y, 'number', locale.value) : t('lb05.result.noValue')
}

/** Writes a point as "horizontal value: quantity". */
function pointText(row: ChartRow): string {
  return t('lb05.chart.point', { x: row.x === null ? t('lb05.result.noValue') : String(row.x), y: value(row) })
}

// The text alternative: what the chart is, how big it is, and its extremes.
const summary = computed(() => {
  const found = facts.value
  if (!found) return ''
  const parts = [t('lb05.chart.summary', { kind: t(`lb05.chart.kinds.${found.kind}`), y: found.yTitle, x: found.xTitle, count: formatCount(found.count, locale.value) })]
  if (found.seriesTitle !== undefined) parts.push(t('lb05.chart.withSeries', { count: formatCount(found.seriesCount, locale.value), series: found.seriesTitle }))
  if (found.extremes) parts.push(t('lb05.chart.extremes', { highest: pointText(found.extremes.highest), lowest: pointText(found.extremes.lowest) }))
  return parts.join(' ')
})
const omitted = computed(() => props.chart?.omitted_rows ?? 0)

/** Takes the chart off the page. */
function clear(): void {
  drawing += 1
  drawn?.destroy()
  drawn = undefined
}

/** Draws the chart in the container at the container's width, in the tokens as the page has them now. */
async function draw(): Promise<void> {
  clear()
  const mine = drawing
  const target = container.value
  const current = spec.value
  if (!target || !current) {
    status.value = 'idle'
    return
  }
  status.value = 'loading'
  try {
    const tokens = readChartTokens(target)
    if (!tokens) throw new Error('The page has no chart tokens.')
    const { drawChart } = await import('../chart/render')
    if (mine !== drawing) return
    const width = target.clientWidth
    const next = await drawChart(target, current, tokens, width, locale.value === 'cs' ? 'cs' : 'en')
    if (mine !== drawing) {
      next.destroy()
      return
    }
    drawn = next
    drawnWidth = width
    status.value = 'ready'
  }
  catch {
    if (mine === drawing) status.value = 'failed'
  }
}

/** Draws the chart again at a new width, once the box has settled on one. */
async function fit(): Promise<void> {
  const target = container.value
  if (!drawn || !target || Math.abs(target.clientWidth - drawnWidth) < 2) return
  drawnWidth = target.clientWidth
  await drawn.resize(drawnWidth)
}

/** Switches the table of the chart's points on or off. */
function toggleTable(): void {
  showTable.value = !showTable.value
}

watch(spec, async () => {
  await nextTick()
  await draw()
}, { flush: 'post' })

onMounted(() => {
  void draw()
  if (typeof MutationObserver !== 'undefined') {
    // The theme is a class on the page; a canvas cannot follow it by itself, so the chart is drawn again.
    themeWatcher = new MutationObserver(() => void draw())
    themeWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
  }
  if (typeof ResizeObserver !== 'undefined' && container.value) {
    sizeWatcher = new ResizeObserver(() => void fit())
    sizeWatcher.observe(container.value)
  }
})

onBeforeUnmount(() => {
  themeWatcher?.disconnect()
  sizeWatcher?.disconnect()
  clear()
})
</script>

<template>
  <section
    class="chart"
    :aria-label="t('lb05.chart.title')"
    data-testid="chart"
  >
    <h3 class="lb-label">
      {{ t('lb05.chart.title') }}
    </h3>

    <p
      v-if="!chart"
      class="note"
      data-testid="chart-none"
    >
      {{ t('lb05.chart.none') }}
    </p>

    <div
      v-else-if="refusal !== undefined"
      class="note"
      role="status"
      data-testid="chart-refused"
    >
      <p>{{ t('lb05.chart.refused') }}</p>
      <p class="why">
        {{ t('lb05.chart.refusedWhy', { reason: refusal }) }}
      </p>
    </div>

    <figure
      v-else
      class="figure"
    >
      <div
        ref="container"
        class="canvas"
        role="img"
        aria-labelledby="lb05-chart-summary"
        :data-status="status"
        data-testid="chart-canvas"
      />
      <p
        v-if="status === 'loading'"
        class="note"
        role="status"
      >
        {{ t('lb05.chart.loading') }}
      </p>
      <p
        v-if="status === 'failed'"
        class="note"
        role="status"
        data-testid="chart-failed"
      >
        {{ t('lb05.chart.failed') }}
      </p>
      <figcaption
        id="lb05-chart-summary"
        class="summary"
        data-testid="chart-summary"
      >
        {{ summary }}
      </figcaption>
      <p
        v-if="omitted > 0"
        class="note"
        data-testid="chart-omitted"
      >
        {{ t('lb05.chart.omitted', { drawn: formatCount(rows.length, locale) }) }}
      </p>
      <div class="actions">
        <button
          type="button"
          class="button"
          :aria-expanded="showTable ? 'true' : 'false'"
          aria-controls="lb05-chart-data"
          data-testid="chart-table-toggle"
          @click="toggleTable"
        >
          {{ showTable ? t('lb05.chart.hideTable') : t('lb05.chart.showTable') }}
        </button>
      </div>
      <div
        v-if="showTable"
        id="lb05-chart-data"
        class="scroll"
        role="region"
        tabindex="0"
        :aria-label="t('lb05.chart.tableCaption')"
      >
        <table data-testid="chart-table">
          <caption class="lb-sr-only">
            {{ t('lb05.chart.tableCaption') }}
          </caption>
          <thead>
            <tr>
              <th scope="col">
                {{ facts?.xTitle }}
              </th>
              <th
                scope="col"
                class="number"
              >
                {{ facts?.yTitle }}
              </th>
              <th
                v-if="seriesTitle !== undefined"
                scope="col"
              >
                {{ seriesTitle }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, index) in rows"
              :key="index"
            >
              <td>{{ row.x === null ? t('lb05.result.noValue') : String(row.x) }}</td>
              <td class="number">
                {{ value(row) }}
              </td>
              <td v-if="seriesTitle !== undefined">
                {{ row.series === null || row.series === undefined ? t('lb05.result.noValue') : String(row.series) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </figure>
  </section>
</template>

<style scoped>
.chart {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.figure {
  display: grid;
  gap: 8px;
  min-width: 0;
  margin: 0;
}

.canvas {
  min-height: 120px;
  max-width: 100%;
  overflow: hidden;
  background: var(--lb-sheet);
  border: 1px solid var(--lb-rule);
}

.canvas :deep(canvas) {
  display: block;
  max-width: 100%;
}

.summary {
  font-size: 13px;
  color: var(--lb-graphite);
}

.note {
  display: grid;
  gap: 4px;
  font-size: 13px;
  color: var(--lb-graphite);
}

.why {
  font-family: var(--lb-font-mono);
  font-size: 12px;
}

.actions {
  display: flex;
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

.scroll {
  max-height: 320px;
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
  padding: 5px 10px;
  text-align: left;
  border-bottom: 1px solid var(--lb-rule);
}

thead th {
  position: sticky;
  top: 0;
  background: var(--lb-shade);
}

.number {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
