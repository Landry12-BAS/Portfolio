<script setup lang="ts">
// <SloPanel>: the service level objective, as code measures it. The shop promises that nearly every
// request at the edge succeeds within a time; each minute the service counts the bad ones, and the
// burn rates say how fast the error budget is being used over a short and a long window. The alert
// fires when both windows of a rule burn fast, and the incident can close only when the SLO has
// recovered. The panel says the state in words with an icon, draws the share of bad requests on a
// gauge with the promise marked on it, and in the Technical reading lists the burn rates.
import { LbIcon } from '@lb/icons'
import { storeToRefs } from 'pinia'
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLb06Store } from '../store'

defineProps<{
  /** The Brief reading leaves out the burn rates. */
  brief: boolean
}>()

/** The share of bad requests at the right end of the gauge, in percent, and the promise's share. */
const GAUGE_MAX_PERCENT = 5
const PROMISE_PERCENT = 0.5

const { t, locale } = useI18n()
const id = useId()
const { slo } = storeToRefs(useLb06Store())

const percent = computed(() => (slo.value ? slo.value.badFraction * 100 : 0))
const fill = computed(() => (Math.min(percent.value, GAUGE_MAX_PERCENT) / GAUGE_MAX_PERCENT) * 100)
const promise = (PROMISE_PERCENT / GAUGE_MAX_PERCENT) * 100
const status = computed(() => (slo.value?.alerting ? 'alerting' : slo.value && !slo.value.healthy ? 'burning' : 'healthy'))
const icon = computed(() => (status.value === 'healthy' ? 'success' : status.value === 'alerting' ? 'error' : 'warning'))
const badText = computed(() => new Intl.NumberFormat(locale.value, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(percent.value))

/** Writes a burn rate the way the visitor's language writes numbers, with at most one decimal. */
function burnText(value: number): string {
  return new Intl.NumberFormat(locale.value, { maximumFractionDigits: 1 }).format(value)
}
</script>

<template>
  <section
    class="lb6-panel"
    :aria-label="t('lb06.slo.title')"
    data-testid="slo"
  >
    <h3>{{ t('lb06.slo.title') }}</h3>
    <p class="lb6-hint">
      {{ t('lb06.slo.target') }}
    </p>
    <div
      v-if="slo"
      class="body"
    >
      <div class="now">
        <p
          class="status"
          role="status"
          data-testid="slo-status"
          :data-status="status"
        >
          <LbIcon
            :name="icon"
            :size="18"
            tone="mono"
          />
          <span>{{ t(`lb06.slo.status.${status}`) }}</span>
        </p>
        <figure class="gauge">
          <svg
            viewBox="0 0 260 34"
            role="img"
            :aria-labelledby="`${id}-title`"
            focusable="false"
          >
            <title :id="`${id}-title`">{{ t('lb06.slo.gauge', { value: badText }) }}</title>
            <rect
              class="track"
              x="1"
              y="8"
              width="258"
              height="14"
            />
            <rect
              class="fill"
              x="1"
              y="8"
              :width="(258 * fill) / 100"
              height="14"
            />
            <line
              class="promise"
              :x1="1 + (258 * promise) / 100"
              :x2="1 + (258 * promise) / 100"
              y1="3"
              y2="27"
            />
            <text
              class="scale"
              x="1"
              y="33"
            >0</text>
            <text
              class="scale"
              x="259"
              y="33"
              text-anchor="end"
            >{{ GAUGE_MAX_PERCENT }} %</text>
          </svg>
        </figure>
        <p
          class="bad"
          data-testid="slo-bad"
        >
          <span class="lb6-hint">{{ t('lb06.slo.bad') }}:</span>
          <strong>{{ t('lb06.slo.badValue', { value: badText }) }}</strong>
        </p>
        <p class="lb6-hint">
          {{ t('lb06.slo.budget') }}
        </p>
      </div>
      <div
        v-if="!brief"
        class="lb6-table-wrap"
        tabindex="0"
        role="region"
        :aria-label="t('lb06.slo.burn')"
      >
        <table
          class="lb6-table"
          data-testid="burn-table"
        >
          <caption class="lb6-hint">
            {{ t('lb06.slo.burnNote') }}
          </caption>
          <thead>
            <tr>
              <th scope="col">
                {{ t('lb06.slo.burn') }}
              </th>
              <th scope="col">
                {{ t('lb06.slo.short') }}
              </th>
              <th scope="col">
                {{ t('lb06.slo.long') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="burn in slo.burns"
              :key="`${burn.shortMinutes}-${burn.longMinutes}`"
            >
              <th scope="row">
                {{ t('lb06.slo.window', { short: burn.shortMinutes, long: burn.longMinutes }) }}
              </th>
              <td class="lb6-mono">
                {{ burnText(burn.shortBurn) }}
              </td>
              <td class="lb6-mono">
                {{ burnText(burn.longBurn) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <p
      v-else
      class="lb6-hint"
    >
      {{ t('lb06.slo.none') }}
    </p>
  </section>
</template>

<style scoped>
/* The state and the gauge on one side, the burn rates on the other when there is room for both. */
.body {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
  gap: 16px 28px;
  align-items: start;
}
.now {
  display: grid;
  gap: 8px;
}
.status {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 15px;
  font-weight: 700;
}
.gauge {
  margin: 0;
}
.gauge svg {
  display: block;
  width: 100%;
  max-width: 420px;
  height: auto;
}
.bad {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 6px;
  align-items: baseline;
}
.track {
  fill: var(--lb-shade);
  stroke: var(--lb-rule);
}
.fill {
  fill: var(--lb-series-1);
}
.promise {
  stroke: var(--lb-ink);
  stroke-width: 2;
}
.scale {
  font: 400 9px var(--lb-font-mono);
  fill: var(--lb-graphite);
}
</style>
