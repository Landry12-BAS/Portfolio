<script setup lang="ts">
// <ScoreFigure>: figure 1 of the report, the share of the ten cases each prompt passed on each provider, with its 95%
// confidence interval, drawn as a dot and whisker: a circle for production's prompt in the first series colour, a
// square for the visitor's in the second, a line through each from the low end of its interval to the high end, on an
// axis from 0 to 100%. The words beside each line and the shape of its mark say which prompt it is, so colour is never
// the only cue. The drawing is for the eye: it is hidden from assistive technology, which reads the figure's text
// alternative below it (each value in a sentence, and whether the intervals overlap) and table 1 beside it, which has
// the same numbers. Each line is its own small drawing whose positions are shares of its width, so the figure keeps its
// text readable at any width; on a narrow screen the label goes above its line.
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { byProvider, intervalsOverlap, scoreAt } from '../report'
import type { Lb10Report, Lb10VariantReport } from '../schemas'
import { useLb10Words } from '../words'

const props = defineProps<{
  report: Lb10Report
}>()

const { t } = useI18n()
const words = useLb10Words()
const id = useId()

// The ticks of the axis, in percent.
const TICKS = [0, 25, 50, 75, 100] as const

/** One line of the figure: a prompt on a provider, where its marks go, and what it says in words. */
interface FigureLine {
  key: string
  variant: Lb10VariantReport['variant']
  label: string
  mean: number
  low: number
  high: number
  value: string
  sentence: string
}

/** One provider's lines, and the sentence on whether its two intervals overlap. */
interface FigureGroup {
  provider: string
  name: string
  lines: FigureLine[]
  overlap: string | undefined
}

/** Builds one line of the figure from a prompt's score. */
function lineOf(provider: string, variant: Lb10VariantReport): FigureLine {
  const label = variant.variant === 'production' ? t('lb10.report.production') : t('lb10.report.edited')
  const inSentence = variant.variant === 'production' ? t('lb10.report.productionInSentence') : t('lb10.report.editedInSentence')
  const { mean, low, high } = variant.score
  return {
    key: `${provider}-${variant.variant}`,
    variant: variant.variant,
    label,
    mean: scoreAt(mean),
    low: scoreAt(low),
    high: scoreAt(high),
    value: `${words.share(mean)} (${t('lb10.report.table.intervalValue', { low: words.share(low), high: words.share(high) })})`,
    sentence: t('lb10.report.score.line', { provider: words.providerName(provider), variant: inSentence, score: words.share(mean), low: words.share(low), high: words.share(high) }),
  }
}

const groups = computed<FigureGroup[]>(() => byProvider(props.report).map((group) => {
  const lines = [group.production, group.edited].filter((variant): variant is Lb10VariantReport => variant !== undefined).map(variant => lineOf(group.provider, variant))
  const name = words.providerName(group.provider)
  let overlap: string | undefined
  if (group.production && group.edited) {
    overlap = intervalsOverlap(group.production.score, group.edited.score) ? t('lb10.report.score.overlap', { provider: name }) : t('lb10.report.score.apart', { provider: name })
  }
  return { provider: group.provider, name, lines, overlap }
}))
</script>

<template>
  <figure
    class="figure"
    :aria-labelledby="`${id}-caption`"
    :aria-describedby="`${id}-words`"
    data-testid="score-figure"
  >
    <figcaption
      :id="`${id}-caption`"
      class="lb10-subtitle"
    >
      {{ t('lb10.report.score.title') }}
    </figcaption>
    <p class="lb10-hint">
      {{ t('lb10.report.score.how') }}
    </p>
    <div
      class="plot"
      aria-hidden="true"
    >
      <div
        v-for="group in groups"
        :key="group.provider"
        class="group"
      >
        <p class="group-name">
          {{ group.name }}
        </p>
        <div
          v-for="line in group.lines"
          :key="line.key"
          class="line"
          :data-variant="line.variant"
        >
          <p class="line-label">
            <svg
              class="key"
              width="12"
              height="12"
              viewBox="0 0 12 12"
              :class="`lb10-mark--${line.variant}`"
            >
              <circle
                v-if="line.variant === 'production'"
                cx="6"
                cy="6"
                r="5"
              />
              <rect
                v-else
                x="1"
                y="1"
                width="10"
                height="10"
              />
            </svg>
            <span>{{ line.label }}</span>
          </p>
          <div class="track-box">
            <svg
              class="track"
              width="100%"
              height="28"
              :class="`lb10-mark--${line.variant}`"
            >
              <line
                v-for="tick in TICKS"
                :key="tick"
                class="grid"
                :x1="`${tick}%`"
                :x2="`${tick}%`"
                y1="2"
                y2="26"
              />
              <line
                class="whisker"
                :x1="`${line.low}%`"
                :x2="`${line.high}%`"
                y1="14"
                y2="14"
              />
              <line
                class="whisker"
                :x1="`${line.low}%`"
                :x2="`${line.low}%`"
                y1="8"
                y2="20"
              />
              <line
                class="whisker"
                :x1="`${line.high}%`"
                :x2="`${line.high}%`"
                y1="8"
                y2="20"
              />
              <svg
                :x="`${line.mean}%`"
                y="14"
                overflow="visible"
              >
                <circle
                  v-if="line.variant === 'production'"
                  class="mark"
                  cx="0"
                  cy="0"
                  r="6.5"
                />
                <rect
                  v-else
                  class="mark"
                  x="-6"
                  y="-6"
                  width="12"
                  height="12"
                />
              </svg>
            </svg>
          </div>
          <p class="line-value lb10-nums">
            {{ line.value }}
          </p>
        </div>
      </div>
      <div class="line axis-line">
        <span />
        <div class="axis">
          <span
            v-for="tick in TICKS"
            :key="tick"
            class="tick"
            :style="{ left: `${tick}%` }"
          >{{ words.share(tick / 100) }}</span>
        </div>
        <span />
      </div>
      <p class="axis-name lb10-hint">
        {{ t('lb10.report.score.axis') }}
      </p>
    </div>
    <ul
      :id="`${id}-words`"
      class="words"
      data-testid="score-words"
    >
      <template
        v-for="group in groups"
        :key="group.provider"
      >
        <li
          v-for="line in group.lines"
          :key="line.key"
        >
          {{ line.sentence }}
        </li>
        <li v-if="group.overlap">
          {{ group.overlap }}
        </li>
      </template>
    </ul>
  </figure>
</template>

<style scoped>
.figure {
  display: grid;
  gap: 8px;
  min-width: 0;
  margin: 0;
  container-type: inline-size;
}
.plot {
  display: grid;
  gap: 10px;
  padding: 10px 12px;
  background: var(--lb-sheet);
  border: 1px solid var(--lb-rule);
}
.group {
  display: grid;
  gap: 4px;
}
.group-name {
  font-size: 13px;
  font-weight: 700;
}
.line {
  display: grid;
  grid-template-columns: minmax(8rem, 11rem) minmax(0, 1fr) minmax(7.5rem, auto);
  gap: 4px 12px;
  align-items: center;
}
.line-label {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 13px;
}
.key {
  flex: none;
  fill: currentColor;
}
.track-box {
  min-width: 0;
  padding: 0 8px;
}
.track {
  display: block;
  overflow: visible;
}
.grid {
  stroke: var(--lb-rule);
  stroke-width: 1;
}
.whisker {
  stroke: currentColor;
  stroke-width: 2.5;
}
.mark {
  fill: currentColor;
  stroke: var(--lb-sheet);
  stroke-width: 1.5;
}
.line-value {
  font-size: 12.5px;
  white-space: nowrap;
}
.axis {
  position: relative;
  height: 18px;
  margin: 0 8px;
}
.tick {
  position: absolute;
  top: 0;
  font-family: var(--lb-font-mono);
  font-size: 10px;
  color: var(--lb-graphite);
  white-space: nowrap;
  transform: translateX(-50%);
}
.axis-name {
  text-align: center;
}
.words {
  display: grid;
  gap: 2px;
  padding-left: 18px;
  margin: 0;
  font-size: 13px;
}
@container (max-width: 520px) {
  .line {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .line-label {
    grid-column: 1 / -1;
  }
  .axis-line > span:first-child {
    display: none;
  }
}
</style>
