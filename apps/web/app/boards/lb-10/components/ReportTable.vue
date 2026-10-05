<script setup lang="ts">
// <ReportTable>: table 1 of the report, the numbers of figure 1 and what each prompt cost. One row for each prompt on
// each provider: the cases it passed, the share with its 95% interval, the median and 95th-percentile latency of its
// calls, the tokens it read and wrote, and its calls, said as computed in this run or answered from the cache (the
// production baseline is computed once for everybody; a cached prompt cost this run nothing, and its latency and tokens
// are those of the calls that first made its results), and the calls that got no answer. The Brief reading keeps the
// score and the calls.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { passedCount } from '../report'
import type { Lb10Report } from '../schemas'
import { useLb10Words } from '../words'

const props = defineProps<{
  report: Lb10Report
  /** The Brief reading leaves out the latency and the tokens. */
  brief: boolean
}>()

const { t } = useI18n()
const words = useLb10Words()

/** Says a prompt's calls: those made in this run and those answered from the cache, each when there are any. */
function callsText(made: number, cached: number): string {
  const parts: string[] = []
  if (made > 0 || cached === 0) parts.push(`${words.number(made)} ${t('lb10.report.table.callsMade')}`)
  if (cached > 0) parts.push(`${words.number(cached)} ${t('lb10.report.table.callsCached')}`)
  return parts.join(', ')
}

const rows = computed(() => props.report.variants.map(variant => ({
  key: `${variant.provider}-${variant.variant}`,
  provider: words.providerName(variant.provider),
  prompt: variant.variant === 'production' ? t('lb10.report.production') : t('lb10.report.edited'),
  variant: variant.variant,
  passed: t('lb10.report.table.passedValue', { passed: words.number(passedCount(variant)), cases: words.number(variant.score.cases) }),
  share: words.share(variant.score.mean),
  interval: t('lb10.report.table.intervalValue', { low: words.share(variant.score.low), high: words.share(variant.score.high) }),
  p50: words.duration(variant.latency_p50_ms),
  p95: words.duration(variant.latency_p95_ms),
  tokens: t('lb10.report.table.tokensValue', { input: words.number(variant.input_tokens), output: words.number(variant.output_tokens) }),
  calls: callsText(variant.model_calls, variant.cached_calls),
  cached: variant.cached_calls > 0,
  failed: words.number(variant.failed_calls),
})))
const anyCached = computed(() => rows.value.some(row => row.cached))
</script>

<template>
  <div class="report-table">
    <div
      class="lb10-table-wrap"
      tabindex="0"
      role="group"
      :aria-label="t('lb10.report.table.caption')"
    >
      <table
        class="lb10-table"
        data-testid="report-table"
      >
        <caption>{{ t('lb10.report.table.caption') }}</caption>
        <thead>
          <tr>
            <th scope="col">
              {{ t('lb10.report.table.provider') }}
            </th>
            <th scope="col">
              {{ t('lb10.report.table.prompt') }}
            </th>
            <th scope="col">
              {{ t('lb10.report.table.passed') }}
            </th>
            <th scope="col">
              {{ t('lb10.report.table.score') }}
            </th>
            <th scope="col">
              {{ t('lb10.report.table.interval') }}
            </th>
            <template v-if="!brief">
              <th scope="col">
                {{ t('lb10.report.table.p50') }}
              </th>
              <th scope="col">
                {{ t('lb10.report.table.p95') }}
              </th>
              <th scope="col">
                {{ t('lb10.report.table.tokens') }}
              </th>
            </template>
            <th scope="col">
              {{ t('lb10.report.table.calls') }}
            </th>
            <th
              v-if="!brief"
              scope="col"
            >
              {{ t('lb10.report.table.failed') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.key"
            :data-variant="row.variant"
            data-testid="report-row"
          >
            <th scope="row">
              {{ row.provider }}
            </th>
            <td>{{ row.prompt }}</td>
            <td class="lb10-num">
              {{ row.passed }}
            </td>
            <td
              class="lb10-num"
              data-testid="row-share"
            >
              {{ row.share }}
            </td>
            <td class="lb10-num">
              {{ row.interval }}
            </td>
            <template v-if="!brief">
              <td class="lb10-num">
                {{ row.p50 }}
              </td>
              <td class="lb10-num">
                {{ row.p95 }}
              </td>
              <td class="lb10-num">
                {{ row.tokens }}
              </td>
            </template>
            <td
              class="lb10-num"
              data-testid="row-calls"
              :data-cached="row.cached"
            >
              {{ row.calls }}
            </td>
            <td
              v-if="!brief"
              class="lb10-num"
            >
              {{ row.failed }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p
      v-if="anyCached"
      class="lb10-hint"
      data-testid="cache-note"
    >
      {{ t('lb10.report.cacheNote') }}
    </p>
  </div>
</template>

<style scoped>
.report-table {
  display: grid;
  gap: 6px;
  min-width: 0;
}
</style>
