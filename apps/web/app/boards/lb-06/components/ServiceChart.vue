<script setup lang="ts">
// <ServiceChart>: one service's line for one metric, drawn as an SVG with no chart library. The
// numbers come from the ticks of the incident's log and the lines are worked out in series.ts, so the
// drawing is only what the numbers say. Everything that matters is also written: the service's state
// in a word with an icon (colour never says it alone), its latest value, the landmarks of the incident
// as letters on dashed lines, and a text alternative that gives the start, the peak and the present
// value. The dashboard offers the same numbers as a table.
import { LbIcon } from '@lb/icons'
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Marker } from '../incident'
import { AXIS_FLOOR, domainOf, factsOf, healthOf, pathOf, seriesOf, xOf } from '../series'
import type { ChartMetric, Frame, TickPoint } from '../series'
import { useLb06Words } from '../words'

const props = defineProps<{
  service: 'web' | 'cart' | 'payment' | 'inventory' | 'database' | 'cache'
  metric: ChartMetric
  ticks: readonly TickPoint[]
  markers: readonly Marker[]
}>()

/** The drawing's size and the room around the plot for the axes' labels, in drawing units. */
const FRAME: Frame = { width: 260, height: 120, left: 44, right: 8, top: 10, bottom: 22 }

const { t } = useI18n()
const words = useLb06Words()
const id = useId()

const points = computed(() => seriesOf(props.ticks, props.service, props.metric))
const domain = computed(() => domainOf(points.value, AXIS_FLOOR[props.metric]))
const path = computed(() => pathOf(points.value, domain.value, FRAME))
const facts = computed(() => factsOf(points.value))
const health = computed(() => healthOf(props.ticks, props.service))
const icon = computed(() => (health.value === 'failing' ? 'error' : health.value === 'elevated' ? 'warning' : 'success'))
const lines = computed(() => props.markers
  .filter(marker => marker.minute >= domain.value.fromMinute && marker.minute <= domain.value.toMinute)
  .map(marker => ({ ...marker, x: xOf(marker.minute, domain.value, FRAME) })))
const title = computed(() => t('lb06.dashboard.chart', { service: words.serviceName(props.service), metric: words.metricName(props.metric) }))
const alt = computed(() => {
  const found = facts.value
  if (!found) return t('lb06.dashboard.empty')
  return t('lb06.dashboard.alt', {
    service: words.serviceName(props.service),
    metric: words.metricName(props.metric),
    first: words.valueText(props.metric, found.first),
    peak: words.valueText(props.metric, found.peak),
    peakMinute: found.peakMinute,
    last: words.valueText(props.metric, found.last),
    lastMinute: found.lastMinute,
  })
})
</script>

<template>
  <figure
    class="chart"
    :data-testid="`chart-${service}`"
    :data-health="health"
  >
    <figcaption class="head">
      <span class="name">{{ words.serviceName(service) }}</span>
      <span
        v-if="health"
        class="health"
        :data-testid="`health-${service}`"
      >
        <LbIcon
          :name="icon"
          :size="14"
          tone="mono"
        />
        <span>{{ words.healthWord(health) }}</span>
      </span>
      <span
        v-if="facts"
        class="now lb6-mono"
        :data-testid="`latest-${service}`"
      >{{ words.valueText(metric, facts.last) }}</span>
    </figcaption>
    <svg
      :viewBox="`0 0 ${FRAME.width} ${FRAME.height}`"
      role="img"
      :aria-labelledby="`${id}-title ${id}-desc`"
      focusable="false"
    >
      <title :id="`${id}-title`">{{ title }}</title>
      <desc :id="`${id}-desc`">{{ alt }}</desc>
      <line
        class="axis"
        :x1="FRAME.left"
        :x2="FRAME.width - FRAME.right"
        :y1="FRAME.height - FRAME.bottom"
        :y2="FRAME.height - FRAME.bottom"
      />
      <line
        class="axis"
        :x1="FRAME.left"
        :x2="FRAME.left"
        :y1="FRAME.top"
        :y2="FRAME.height - FRAME.bottom"
      />
      <text
        class="tick"
        :x="FRAME.left - 4"
        :y="FRAME.top + 4"
        text-anchor="end"
      >{{ words.valueText(metric, domain.top) }}</text>
      <text
        class="tick"
        :x="FRAME.left - 4"
        :y="FRAME.height - FRAME.bottom"
        text-anchor="end"
      >0</text>
      <text
        class="tick"
        :x="FRAME.left"
        :y="FRAME.height - 6"
      >{{ domain.fromMinute }}</text>
      <text
        class="tick"
        :x="FRAME.width - FRAME.right"
        :y="FRAME.height - 6"
        text-anchor="end"
      >{{ domain.toMinute }}</text>
      <g
        v-for="line in lines"
        :key="line.seq"
      >
        <line
          class="marker"
          :x1="line.x"
          :x2="line.x"
          :y1="FRAME.top"
          :y2="FRAME.height - FRAME.bottom"
        />
        <text
          class="letter"
          :x="line.x + 2"
          :y="FRAME.top + 8"
        >{{ words.markerLetter(line.kind) }}</text>
      </g>
      <path
        v-if="path"
        class="line"
        :d="path"
      />
    </svg>
  </figure>
</template>

<style scoped>
.chart {
  display: grid;
  gap: 4px;
  min-width: 0;
  padding: 8px 10px;
  margin: 0;
  background: var(--lb-sheet);
  border: 1px solid var(--lb-rule);
}
/* A failing service is drawn with a heavier frame as well as its word and icon, so it never depends on colour. */
.chart[data-health="failing"] {
  border: 2px solid var(--lb-ink);
}
.head {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  align-items: baseline;
}
.name {
  font-size: 13px;
  font-weight: 700;
}
.health {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  font-size: 12px;
  font-weight: 600;
}
.now {
  margin-left: auto;
  font-size: 12px;
}
svg {
  display: block;
  width: 100%;
  height: auto;
}
.axis {
  stroke: var(--lb-rule);
  stroke-width: 1;
}
.tick {
  font: 400 9px var(--lb-font-mono);
  fill: var(--lb-graphite);
}
.line {
  fill: none;
  stroke: var(--lb-series-1);
  stroke-width: 1.7;
  stroke-linejoin: round;
}
.marker {
  stroke: var(--lb-graphite);
  stroke-dasharray: 3 2;
  stroke-width: 1;
}
.letter {
  font: 700 9px var(--lb-font-mono);
  fill: var(--lb-ink);
}
</style>
