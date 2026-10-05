<script setup lang="ts">
// <ShopDashboard>: the simulated shop, a chart for each service, one metric at a time (small
// multiples, so the eye can see which service moved first). The visitor chooses the metric; the
// charts, the landmarks marked on them and the table of the same numbers all come from the ticks the
// store holds. While the visitor has paused the charts they show the log up to the moment of the
// pause. The table is the way to read the numbers without the drawing, and is offered on the same
// page, not on another.
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { CHART_METRICS, SERVICES } from '../series'
import type { ChartMetric } from '../series'
import { useLb06Store } from '../store'
import { useLb06Words } from '../words'
import ServiceChart from './ServiceChart.vue'

defineProps<{
  /** The Brief reading leaves out the explanation of each metric. */
  brief: boolean
}>()

/** How many of the newest minutes the table shows until the visitor asks for every one. */
const RECENT_MINUTES = 12

const { t, te } = useI18n()
const words = useLb06Words()
const { ticks, markers, paused } = storeToRefs(useLb06Store())

const metric = ref<ChartMetric>('error_rate')
const tableShown = ref(false)
const everyMinute = ref(false)
const rows = computed(() => (everyMinute.value ? ticks.value : ticks.value.slice(-RECENT_MINUTES)))
const lastMinute = computed(() => ticks.value.at(-1)?.minute ?? 0)
const note = computed(() => (te(`lb06.metricNotes.${metric.value}`) ? t(`lb06.metricNotes.${metric.value}`) : undefined))
</script>

<template>
  <section
    class="lb6-panel"
    :aria-label="t('lb06.dashboard.title')"
    data-testid="dashboard"
  >
    <h3>{{ t('lb06.dashboard.title') }}</h3>
    <fieldset class="metrics">
      <legend>{{ t('lb06.dashboard.metricLegend') }}</legend>
      <label
        v-for="name in CHART_METRICS"
        :key="name"
        class="metric"
      >
        <input
          v-model="metric"
          type="radio"
          name="lb06-metric"
          :value="name"
          :data-testid="`metric-${name}`"
        >
        <span>{{ words.metricName(name) }}</span>
      </label>
    </fieldset>
    <p
      v-if="note && !brief"
      class="lb6-hint"
    >
      {{ note }}
    </p>
    <p
      v-if="paused"
      class="lb6-hint paused"
      role="status"
      data-testid="paused-note"
    >
      {{ t('lb06.dashboard.paused', { minute: lastMinute }) }}
    </p>
    <div class="grid">
      <ServiceChart
        v-for="service in SERVICES"
        :key="service"
        :service="service"
        :metric="metric"
        :ticks="ticks"
        :markers="markers"
      />
    </div>
    <div
      v-if="markers.length > 0"
      class="legend"
    >
      <h4>{{ t('lb06.dashboard.markerLegend') }}</h4>
      <ul data-testid="marker-legend">
        <li
          v-for="marker in markers"
          :key="marker.seq"
        >
          <span class="letter lb6-mono">{{ words.markerLetter(marker.kind) }}</span>
          {{ t('lb06.dashboard.markerAt', { marker: words.markerName(marker.kind), minute: marker.minute }) }}
        </li>
      </ul>
    </div>
    <div class="lb6-row">
      <button
        type="button"
        class="lb6-button lb6-button--quiet"
        :aria-expanded="tableShown"
        aria-controls="lb06-table"
        data-testid="table-toggle"
        @click="tableShown = !tableShown"
      >
        {{ tableShown ? t('lb06.dashboard.hideTable') : t('lb06.dashboard.table') }}
      </button>
    </div>
    <div
      v-if="tableShown"
      id="lb06-table"
      class="lb6-table-wrap"
      tabindex="0"
      role="region"
      :aria-label="t('lb06.dashboard.tableCaption', { metric: words.metricName(metric) })"
    >
      <table
        class="lb6-table"
        data-testid="data-table"
      >
        <caption class="lb6-hint">
          {{ t('lb06.dashboard.tableCaption', { metric: words.metricName(metric) }) }}
        </caption>
        <thead>
          <tr>
            <th scope="col">
              {{ t('lb06.dashboard.tableMinute') }}
            </th>
            <th
              v-for="service in SERVICES"
              :key="service"
              scope="col"
            >
              {{ words.serviceName(service) }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="tick in rows"
            :key="tick.seq"
          >
            <th scope="row">
              {{ tick.minute }}
            </th>
            <td
              v-for="service in SERVICES"
              :key="service"
            >
              {{ words.valueText(metric, tick.metrics[service][metric]) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div
      v-if="tableShown && ticks.length > 12"
      class="lb6-row"
    >
      <button
        type="button"
        class="lb6-button lb6-button--quiet"
        data-testid="table-all"
        @click="everyMinute = !everyMinute"
      >
        {{ everyMinute ? t('lb06.dashboard.showLastMinutes') : t('lb06.dashboard.showAllMinutes') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  padding: 0;
  margin: 0;
  border: 0;
}
.metrics legend {
  margin-bottom: 4px;
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}
.metric {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  min-height: 32px;
  padding: 4px 10px;
  font-size: 13px;
  cursor: pointer;
  border: 1.5px solid var(--lb-rule);
  border-radius: 4px;
}
.metric:has(input:checked) {
  font-weight: 700;
  border-color: var(--lb-ink);
}
.metric:has(input:focus-visible) {
  outline: 2px solid var(--lb-signal);
  outline-offset: 2px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
}
.legend h4 {
  margin: 0 0 4px;
  font-family: var(--lb-font-mono);
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}
.legend ul {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  padding: 0;
  margin: 0;
  font-size: 13px;
  list-style: none;
}
.letter {
  display: inline-block;
  min-width: 22px;
  margin-right: 4px;
  font-weight: 700;
}
.paused {
  font-weight: 600;
}
</style>
