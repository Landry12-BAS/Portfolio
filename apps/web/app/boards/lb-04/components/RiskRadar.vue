<script setup lang="ts">
// <RiskRadar>: the review's nine topics on a radar, one axis for each, with a ring for each severity from
// low to critical and a shape through the worst verified finding of every topic. The drawing is made by
// code from the report's own scores (radar.ts) and nothing else, so it can say no more than the table
// beside it, which has the same numbers as words: the table is the radar's text alternative and also
// its keyboard control, since each topic in it is a button that narrows the list of findings to that
// topic. The SVG carries a title and a description, and is otherwise decoration for assistive technology.
import type { Lb04RadarScore, Lb04Topic } from '@lb/contracts'
import { LB04_SEVERITIES } from '@lb/contracts'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { buildRadar } from '../radar'
import SeverityMark from './SeverityMark.vue'

const props = defineProps<{
  scores: readonly Lb04RadarScore[]
  /** The topic the list of findings is narrowed to, if any. */
  selected: Lb04Topic | undefined
}>()

const emit = defineEmits<{ select: [topic: Lb04Topic | undefined] }>()

const { t } = useI18n()

const shape = computed(() => buildRadar(props.scores))
const withFindings = computed(() => props.scores.filter(entry => entry.score > 0))
// What the drawing says in a sentence: how many topics have a finding and which is worst.
const description = computed(() => {
  const worst = Math.max(0, ...props.scores.map(entry => entry.score))
  if (worst === 0) return t('lb04.radar.descriptionEmpty')
  const names = props.scores.filter(entry => entry.score === worst).map(entry => t(`lb04.topics.${entry.topic}`)).join(', ')
  return t('lb04.radar.description', { count: withFindings.value.length, total: props.scores.length, worst: t(`lb04.severities.${LB04_SEVERITIES[worst - 1] ?? 'low'}`), topics: names })
})

/** Narrows the findings to a topic, or takes the narrowing off when the topic is the one already chosen. */
function choose(topic: Lb04Topic): void {
  emit('select', props.selected === topic ? undefined : topic)
}
</script>

<template>
  <section
    class="lb4-section radar"
    aria-labelledby="lb4-radar-heading"
    data-testid="radar"
  >
    <h2 id="lb4-radar-heading">
      {{ t('lb04.radar.title') }}
    </h2>
    <div class="layout">
      <svg
        class="drawing"
        :viewBox="`0 0 ${shape.size} ${shape.size}`"
        role="img"
        aria-labelledby="lb4-radar-title lb4-radar-desc"
      >
        <title id="lb4-radar-title">{{ t('lb04.radar.title') }}</title>
        <desc id="lb4-radar-desc">{{ description }}</desc>
        <polygon
          v-for="ring in shape.rings"
          :key="ring.score"
          :points="ring.points"
          class="ring"
        />
        <line
          v-for="axis in shape.axes"
          :key="`axis-${axis.topic}`"
          :x1="shape.centre.x"
          :y1="shape.centre.y"
          :x2="axis.tip.x"
          :y2="axis.tip.y"
          class="spoke"
        />
        <polygon
          :points="shape.polygon"
          class="area"
          data-testid="radar-area"
        />
        <circle
          v-for="axis in shape.axes"
          :key="`point-${axis.topic}`"
          :cx="axis.point.x"
          :cy="axis.point.y"
          :r="axis.score > 0 ? 5 : 2.5"
          class="point"
          :class="{ 'point--empty': axis.score === 0 }"
        />
        <text
          v-for="axis in shape.axes"
          :key="`label-${axis.topic}`"
          :x="axis.label.x"
          :y="axis.label.y"
          :text-anchor="axis.label.anchor"
          dominant-baseline="middle"
          class="label"
          :class="{ 'label--on': selected === axis.topic }"
          aria-hidden="true"
        >{{ t(`lb04.topics.${axis.topic}`) }}</text>
      </svg>

      <div class="lb4-table-wrap">
        <table class="lb4-table">
          <caption class="lb-sr-only">
            {{ t('lb04.radar.tableCaption') }}
          </caption>
          <thead>
            <tr>
              <th scope="col">
                {{ t('lb04.radar.columns.topic') }}
              </th>
              <th scope="col">
                {{ t('lb04.radar.columns.worst') }}
              </th>
              <th
                scope="col"
                class="num"
              >
                {{ t('lb04.radar.columns.findings') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in scores"
              :key="entry.topic"
            >
              <th scope="row">
                <button
                  type="button"
                  class="topic"
                  :aria-pressed="selected === entry.topic"
                  :disabled="entry.findings === 0"
                  @click="choose(entry.topic)"
                >
                  {{ t(`lb04.topics.${entry.topic}`) }}
                </button>
              </th>
              <td>
                <SeverityMark
                  v-if="entry.score > 0"
                  :severity="LB04_SEVERITIES[entry.score - 1] ?? 'low'"
                />
                <span
                  v-else
                  class="none"
                >{{ t('lb04.radar.none') }}</span>
              </td>
              <td class="num lb4-nums">
                {{ entry.findings }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

@media (min-width: 900px) {
  .layout {
    grid-template-columns: minmax(280px, 380px) minmax(0, 1fr);
  }
}

.drawing {
  width: 100%;
  max-width: 460px;
  height: auto;
  justify-self: center;
}

.ring {
  fill: none;
  stroke: var(--lb-rule);
  stroke-width: 1;
}

.spoke {
  stroke: var(--lb-rule);
  stroke-width: 1;
}

.area {
  fill: var(--lb-series-1);
  fill-opacity: 0.22;
  stroke: var(--lb-series-1);
  stroke-width: 2;
  stroke-linejoin: round;
}

.point {
  fill: var(--lb-series-1);
  stroke: var(--lb-sheet);
  stroke-width: 1.5;
}

.point--empty {
  fill: var(--lb-graphite);
}

.label {
  font: 600 13px var(--lb-font-sans);
  fill: var(--lb-ink);
}

.label--on {
  fill: var(--lb-signal);
  text-decoration: underline;
}

.num {
  text-align: right;
}

.topic {
  padding: 2px 6px;
  margin-left: -6px;
  font: inherit;
  font-weight: 600;
  color: var(--lb-ink);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 1.5px solid transparent;
  border-radius: 4px;
}

.topic:hover:not(:disabled) {
  border-color: var(--lb-rule);
}

.topic[aria-pressed="true"] {
  color: var(--lb-sheet);
  background: var(--lb-ink);
}

.topic:disabled {
  cursor: default;
  color: var(--lb-graphite);
}

.none {
  color: var(--lb-graphite);
}
</style>
