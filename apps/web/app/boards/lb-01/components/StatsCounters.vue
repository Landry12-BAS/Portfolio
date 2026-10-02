<script setup lang="ts">
// <StatsCounters>: the visitor's own counters for the demo: how many tickets they have filed,
// what is waiting, and the two numbers that say how useful the copilot has been for them,
// deflection and accuracy. Both are the visitor's own, never a measurement of the system (the
// datasheet's measured numbers come from the eval harness), and both say what they count. A share
// with nothing to count yet reads "no data yet" instead of a zero that would look like a result.
import { useI18n } from 'vue-i18n'

import { formatCount, formatShare } from '~/board-kit/format'

import type { Stats } from '../schemas'

defineProps<{
  stats: Stats | undefined
}>()

const { t, locale } = useI18n()
</script>

<template>
  <section
    class="counters"
    :aria-label="t('lb01.counters.title')"
    data-testid="counters"
  >
    <h2 class="lb-label">
      {{ t('lb01.counters.title') }}
    </h2>
    <p
      v-if="!stats"
      class="quiet"
    >
      {{ t('lb01.counters.none') }}
    </p>
    <dl
      v-else
      class="grid"
    >
      <div>
        <dt>{{ t('lb01.counters.tickets') }}</dt>
        <dd>{{ formatCount(stats.tickets, locale) }}</dd>
      </div>
      <div>
        <dt>{{ t('lb01.counters.waiting') }}</dt>
        <dd>{{ formatCount(stats.awaiting_approval, locale) }}</dd>
      </div>
      <div>
        <dt>{{ t('lb01.counters.sent') }}</dt>
        <dd>{{ formatCount(stats.sent, locale) }}</dd>
      </div>
      <div>
        <dt>{{ t('lb01.counters.escalated') }}</dt>
        <dd>{{ formatCount(stats.escalated, locale) }}</dd>
      </div>
      <div class="wide">
        <dt>{{ t('lb01.counters.deflection') }}</dt>
        <dd
          data-testid="deflection"
          :class="{ empty: stats.deflection === null }"
        >
          {{ stats.deflection === null ? t('lb01.counters.noData') : formatShare(stats.deflection, locale) }}
        </dd>
        <dd class="help">
          {{ t('lb01.counters.deflectionHelp') }}
        </dd>
      </div>
      <div class="wide">
        <dt>{{ t('lb01.counters.accuracy') }}</dt>
        <dd
          data-testid="accuracy"
          :class="{ empty: stats.accuracy === null }"
        >
          {{ stats.accuracy === null ? t('lb01.counters.noData') : formatShare(stats.accuracy, locale) }}
        </dd>
        <dd class="help">
          {{ t('lb01.counters.accuracyHelp') }}
        </dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.counters {
  display: grid;
  gap: 8px;
}

.quiet {
  font-size: 14px;
  color: var(--lb-graphite);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 10px 16px;
  margin: 0;
}

.grid div {
  display: grid;
  gap: 2px;
  align-content: start;
}

.wide {
  grid-column: span 2;
}

dt {
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

dd {
  margin: 0;
  font-family: var(--lb-font-mono);
  font-size: 16px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

/* "No data yet" is a sentence, not a measurement, so it is not drawn like one. */
dd.empty {
  font-family: var(--lb-font-sans);
  font-size: 14px;
  font-weight: 400;
  color: var(--lb-graphite);
}

.help {
  font-family: var(--lb-font-sans);
  font-size: 12px;
  font-weight: 400;
  color: var(--lb-graphite);
}
</style>
