<script setup lang="ts">
// <DifferenceFigure>: figure 2 of the report and its verdicts. For each provider, the visitor's prompt minus
// production's, case by case on the same ten cases, as points of a hundred: the mark is the average difference and the
// line through it the 95% interval of the paired bootstrap, on an axis from -100 to +100 with the zero line drawn
// heavier. Beside it, the service's verdict in words: better or worse only when the whole interval is on one side of
// zero, and "no detectable difference" whenever it includes zero, whatever the two scores say, so a lucky difference
// is never shown as a result. The drawing is hidden from assistive technology; the sentence for each provider says the
// same, with the cases that improved and regressed. A verdict that rests on calls that got no answer (which the service
// counts as failed cases: a free budget spent for the minute, an outage) says so beside it, with the gateway's reasons.
import { LbIcon } from '@lb/icons'
import type { IconName } from '@lb/icons'
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { differenceAt } from '../report'
import type { Unanswered } from '../report'
import type { Lb10Comparison } from '../schemas'
import { useLb10Words } from '../words'

const props = defineProps<{
  comparisons: readonly Lb10Comparison[]
  /** The calls of each provider that got no answer, which the service counted as failed cases. */
  unanswered: ReadonlyMap<string, Unanswered>
}>()

const { t } = useI18n()
const words = useLb10Words()
const id = useId()

// The ticks of the axis, as differences of shares.
const TICKS = [-1, -0.5, 0, 0.5, 1] as const
// The icon each verdict carries, so a verdict is never told by colour alone.
const VERDICT_ICONS: Readonly<Record<string, IconName>> = { better: 'success', worse: 'error', no_detectable_difference: 'info', not_comparable: 'close' }

/** Says how many calls on a provider got no answer and why, or nothing when every call was answered. */
function unansweredText(provider: string, name: string): string | undefined {
  const found = props.unanswered.get(provider)
  if (!found || found.count === 0) return undefined
  return words.counted('lb10.report.difference.unanswered', found.count, { provider: name, reasons: found.codes.map(code => words.gatewayReason(code)).join('; ') })
}

const rows = computed(() => props.comparisons.map((comparison) => {
  const provider = words.providerName(comparison.provider)
  return {
    unanswered: unansweredText(comparison.provider, provider),
    key: comparison.provider,
    provider,
    verdict: comparison.verdict,
    at: differenceAt(comparison.difference),
    low: differenceAt(comparison.low),
    high: differenceAt(comparison.high),
    value: `${words.points(comparison.difference)} (${t('lb10.report.table.intervalValue', { low: words.points(comparison.low), high: words.points(comparison.high) })})`,
    sentence: t('lb10.report.difference.line', {
      provider,
      difference: words.points(comparison.difference),
      low: words.points(comparison.low),
      high: words.points(comparison.high),
      improved: words.number(comparison.improved),
      regressed: words.number(comparison.regressed),
    }),
  }
}))
</script>

<template>
  <figure
    class="figure"
    :aria-labelledby="`${id}-caption`"
    :aria-describedby="`${id}-words`"
    data-testid="difference-figure"
  >
    <figcaption
      :id="`${id}-caption`"
      class="lb10-subtitle"
    >
      {{ t('lb10.report.difference.title') }}
    </figcaption>
    <p class="lb10-hint">
      {{ t('lb10.report.difference.how') }}
    </p>
    <div
      class="plot"
      aria-hidden="true"
    >
      <div
        v-for="row in rows"
        :key="row.key"
        class="line"
      >
        <p class="line-label">
          {{ row.provider }}
        </p>
        <div class="track-box">
          <svg
            class="track"
            width="100%"
            height="28"
          >
            <line
              v-for="tick in TICKS"
              :key="tick"
              :class="tick === 0 ? 'zero' : 'grid'"
              :x1="`${differenceAt(tick)}%`"
              :x2="`${differenceAt(tick)}%`"
              y1="1"
              y2="27"
            />
            <line
              class="whisker"
              :x1="`${row.low}%`"
              :x2="`${row.high}%`"
              y1="14"
              y2="14"
            />
            <line
              class="whisker"
              :x1="`${row.low}%`"
              :x2="`${row.low}%`"
              y1="8"
              y2="20"
            />
            <line
              class="whisker"
              :x1="`${row.high}%`"
              :x2="`${row.high}%`"
              y1="8"
              y2="20"
            />
            <svg
              :x="`${row.at}%`"
              y="14"
              overflow="visible"
            >
              <polygon
                class="mark"
                points="0,-7 7,0 0,7 -7,0"
              />
            </svg>
          </svg>
        </div>
        <p class="line-value lb10-nums">
          {{ row.value }}
        </p>
      </div>
      <div class="line axis-line">
        <span />
        <div class="axis">
          <span
            v-for="tick in TICKS"
            :key="tick"
            class="tick"
            :class="{ 'tick--half': Math.abs(tick) === 0.5 }"
            :style="{ left: `${differenceAt(tick)}%` }"
          >{{ tick === 0 ? t('lb10.report.difference.zero') : words.points(tick) }}</span>
        </div>
        <span />
      </div>
      <p class="axis-name lb10-hint">
        {{ t('lb10.report.difference.axis') }}
      </p>
    </div>
    <ul
      :id="`${id}-words`"
      class="verdicts"
    >
      <li
        v-for="row in rows"
        :key="row.key"
        class="verdict"
        data-testid="verdict"
        :data-verdict="row.verdict"
      >
        <p class="verdict-word">
          <LbIcon
            :name="VERDICT_ICONS[row.verdict] ?? 'info'"
            :size="16"
            tone="mono"
          />
          <span>{{ row.provider }}: {{ words.verdictWord(row.verdict) }}</span>
        </p>
        <p>{{ words.verdictText(row.verdict) }}</p>
        <p class="lb10-hint">
          {{ row.sentence }}
        </p>
        <p
          v-if="row.unanswered"
          class="unanswered"
          data-testid="verdict-unanswered"
        >
          <LbIcon
            name="warning"
            :size="14"
            tone="mono"
          />
          <span>{{ row.unanswered }}</span>
        </p>
      </li>
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
.line {
  display: grid;
  grid-template-columns: minmax(8rem, 11rem) minmax(0, 1fr) minmax(7.5rem, auto);
  gap: 4px 12px;
  align-items: center;
}
.line-label {
  font-size: 13px;
  font-weight: 700;
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
.zero {
  stroke: var(--lb-graphite);
  stroke-width: 2;
  stroke-dasharray: 4 3;
}
.whisker {
  stroke: var(--lb-ink);
  stroke-width: 2.5;
}
.mark {
  fill: var(--lb-ink);
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
.verdicts {
  display: grid;
  gap: 10px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.verdict {
  display: grid;
  gap: 2px;
  padding: 8px 10px;
  border-left: 3px solid var(--lb-ink);
  background: var(--lb-shade);
}
.verdict-word {
  display: flex;
  gap: 6px;
  align-items: center;
  font-weight: 700;
}
/* A verdict swayed by calls that got no answer says so in words, with a warning sign, never by colour alone. */
.unanswered {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin-top: 4px;
  font-size: 13px;
  font-weight: 600;
}
.unanswered > :first-child {
  flex: none;
  margin-top: 2px;
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
  /* A narrow axis keeps its ends and the zero line's words, which need the room between them. */
  .tick--half {
    display: none;
  }
}
</style>
