<script setup lang="ts">
// <NightlyPanel>: "The nightly, the judge and the gate". What the nightly runs, what the LLM judge is and when its
// scores count (eight labels in ten matched and a Cohen's kappa of 0.6 or more, measured each night on a hand-labelled
// set), and what the CI gate holds every pack to; then what the service has stored: the nightly's scores of
// production's prompts on each provider, the judge's scores with whether they count, in words, and the committed
// baselines. Nothing has been run live yet, so each of these is normally empty, and says why rather than looking
// broken. A stored row this page cannot read is left out and said to be.
import { storeToRefs } from 'pinia'
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { nightlyEvalSchema, nightlyJudgeSchema } from '../schemas'
import type { Lb10NightlyRow } from '../schemas'
import { useLb10Store } from '../store'
import { useLb10Words } from '../words'

const { t } = useI18n()
const words = useLb10Words()
const store = useLb10Store()
const { nightly, nightlyStatus, baselines, baselinesStatus, targets } = storeToRefs(store)
const id = useId()

/** Names a pack by its title, or by the name the service gives its target. */
function packName(pack: string): string {
  return words.packTitle(pack, targets.value?.targets.find(item => item.pack === pack)?.name)
}

/** Writes a share with its interval. */
function interval(low: number, high: number): string {
  return t('lb10.report.table.intervalValue', { low: words.share(low), high: words.share(high) })
}

/** Reads the eval rows the page can read, newest first as stored. */
function evalRows(rows: readonly Lb10NightlyRow[]) {
  return rows.flatMap((row, index) => {
    if (row.kind !== 'eval') return []
    const report = nightlyEvalSchema.safeParse(row.report)
    if (!report.success) return []
    return [{
      key: index,
      day: row.run_on,
      pack: packName(row.pack),
      provider: words.providerName(report.data.provider),
      alias: row.alias,
      score: words.share(report.data.score.mean),
      interval: interval(report.data.score.low, report.data.score.high),
      calls: `${words.number(report.data.model_calls)}, ${words.number(report.data.cached_calls)}`,
    }]
  })
}

/** Reads the judge rows the page can read. */
function judgeRows(rows: readonly Lb10NightlyRow[]) {
  return rows.flatMap((row, index) => {
    if (row.kind !== 'judge') return []
    const report = nightlyJudgeSchema.safeParse(row.report)
    if (!report.success) return []
    return [{
      key: index,
      day: row.run_on,
      pack: packName(row.pack),
      alias: row.alias,
      judge: `${words.share(report.data.judge_pass_rate)} (${interval(report.data.judge_low, report.data.judge_high)})`,
      rules: words.share(report.data.rule_pass_rate),
      agreement: words.share(report.data.agreement_with_rules),
      counts: report.data.counts,
    }]
  })
}

const evals = computed(() => evalRows(nightly.value))
const judges = computed(() => judgeRows(nightly.value))
const unreadable = computed(() => nightly.value.length > evals.value.length + judges.value.length)
const committed = computed(() => baselines.value.map((baseline, index) => ({
  key: index,
  pack: packName(baseline.pack),
  alias: baseline.alias,
  score: words.share(baseline.score),
  interval: interval(baseline.low, baseline.high),
  cases: words.number(baseline.cases),
  measured: baseline.measured_on,
  source: t(`lb10.nightly.sources.${baseline.source}`),
})))
</script>

<template>
  <section
    id="lb10-nightly"
    class="lb10-section"
    :aria-labelledby="`${id}-title`"
    data-testid="nightly-panel"
  >
    <h2 :id="`${id}-title`">
      {{ t('lb10.nightly.title') }}
    </h2>
    <p>{{ t('lb10.nightly.what') }}</p>
    <p>{{ t('lb10.nightly.judgeWhat') }}</p>
    <p>{{ t('lb10.nightly.gateWhat') }}</p>
    <p
      v-if="nightlyStatus === 'loading'"
      class="lb10-hint"
      role="status"
    >
      {{ t('lb10.nightly.loading') }}
    </p>
    <p
      v-else-if="nightlyStatus === 'failed'"
      class="lb10-hint"
      role="status"
      data-testid="nightly-failed"
    >
      {{ t('lb10.nightly.failed') }}
    </p>
    <template v-else>
      <div
        class="lb10-panel"
        data-testid="nightly-results"
      >
        <h3>{{ t('lb10.nightly.results') }}</h3>
        <p
          v-if="evals.length === 0"
          data-testid="no-nightly"
        >
          {{ t('lb10.nightly.noResults') }}
        </p>
        <template v-else>
          <p
            :id="`${id}-results-caption`"
            class="lb10-caption"
          >
            {{ t('lb10.nightly.resultsCaption') }}
          </p>
          <div
            class="lb10-table-wrap"
            tabindex="0"
            role="group"
            :aria-labelledby="`${id}-results-caption`"
          >
            <table
              class="lb10-table"
              :aria-labelledby="`${id}-results-caption`"
            >
              <thead>
                <tr>
                  <th scope="col">
                    {{ t('lb10.nightly.columns.day') }}
                  </th>
                  <th scope="col">
                    {{ t('lb10.nightly.columns.pack') }}
                  </th>
                  <th scope="col">
                    {{ t('lb10.nightly.columns.provider') }}
                  </th>
                  <th scope="col">
                    {{ t('lb10.nightly.columns.score') }}
                  </th>
                  <th scope="col">
                    {{ t('lb10.nightly.columns.interval') }}
                  </th>
                  <th scope="col">
                    {{ t('lb10.nightly.columns.calls') }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in evals"
                  :key="row.key"
                >
                  <td class="lb10-num">
                    {{ row.day }}
                  </td>
                  <th scope="row">
                    {{ row.pack }}
                  </th>
                  <td>
                    {{ row.provider }} <span class="lb10-mono lb10-hint">{{ row.alias }}</span>
                  </td>
                  <td class="lb10-num">
                    {{ row.score }}
                  </td>
                  <td class="lb10-num">
                    {{ row.interval }}
                  </td>
                  <td class="lb10-num">
                    {{ row.calls }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
      <div
        class="lb10-panel"
        data-testid="nightly-judge"
      >
        <h3>{{ t('lb10.nightly.judge') }}</h3>
        <p
          v-if="judges.length === 0"
          data-testid="no-judge"
        >
          {{ t('lb10.nightly.noJudge') }}
        </p>
        <template v-else>
          <p
            :id="`${id}-judge-caption`"
            class="lb10-caption"
          >
            {{ t('lb10.nightly.judgeCaption') }}
          </p>
          <div
            class="lb10-table-wrap"
            tabindex="0"
            role="group"
            :aria-labelledby="`${id}-judge-caption`"
          >
            <table
              class="lb10-table"
              :aria-labelledby="`${id}-judge-caption`"
            >
              <thead>
                <tr>
                  <th scope="col">
                    {{ t('lb10.nightly.columns.day') }}
                  </th>
                  <th scope="col">
                    {{ t('lb10.nightly.columns.pack') }}
                  </th>
                  <th scope="col">
                    {{ t('lb10.nightly.columns.judge') }}
                  </th>
                  <th scope="col">
                    {{ t('lb10.nightly.columns.rules') }}
                  </th>
                  <th scope="col">
                    {{ t('lb10.nightly.columns.agreement') }}
                  </th>
                  <th scope="col">
                    {{ t('lb10.nightly.columns.standing') }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in judges"
                  :key="row.key"
                  data-testid="judge-row"
                  :data-counts="row.counts"
                >
                  <td class="lb10-num">
                    {{ row.day }}
                  </td>
                  <th scope="row">
                    {{ row.pack }} <span class="lb10-mono lb10-hint">{{ row.alias }}</span>
                  </th>
                  <td class="lb10-num">
                    {{ row.judge }}
                  </td>
                  <td class="lb10-num">
                    {{ row.rules }}
                  </td>
                  <td class="lb10-num">
                    {{ row.agreement }}
                  </td>
                  <td>{{ row.counts ? t('lb10.nightly.counts') : t('lb10.nightly.doesNotCount') }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
      <p
        v-if="unreadable"
        class="lb10-hint"
        data-testid="nightly-unreadable"
      >
        {{ t('lb10.nightly.unreadable') }}
      </p>
    </template>
    <div
      class="lb10-panel"
      data-testid="baselines"
    >
      <h3>{{ t('lb10.nightly.baselines') }}</h3>
      <p
        v-if="baselinesStatus === 'loading'"
        class="lb10-hint"
        role="status"
      >
        {{ t('lb10.nightly.loading') }}
      </p>
      <p
        v-else-if="baselinesStatus === 'failed'"
        class="lb10-hint"
        role="status"
      >
        {{ t('lb10.nightly.failed') }}
      </p>
      <p
        v-else-if="committed.length === 0"
        data-testid="no-baselines"
      >
        {{ t('lb10.nightly.noBaselines') }}
      </p>
      <template v-else>
        <p
          :id="`${id}-baselines-caption`"
          class="lb10-caption"
        >
          {{ t('lb10.nightly.baselinesCaption') }}
        </p>
        <div
          class="lb10-table-wrap"
          tabindex="0"
          role="group"
          :aria-labelledby="`${id}-baselines-caption`"
        >
          <table
            class="lb10-table"
            :aria-labelledby="`${id}-baselines-caption`"
          >
            <thead>
              <tr>
                <th scope="col">
                  {{ t('lb10.nightly.columns.pack') }}
                </th>
                <th scope="col">
                  {{ t('lb10.nightly.columns.alias') }}
                </th>
                <th scope="col">
                  {{ t('lb10.nightly.columns.score') }}
                </th>
                <th scope="col">
                  {{ t('lb10.nightly.columns.interval') }}
                </th>
                <th scope="col">
                  {{ t('lb10.nightly.columns.cases') }}
                </th>
                <th scope="col">
                  {{ t('lb10.nightly.columns.measured') }}
                </th>
                <th scope="col">
                  {{ t('lb10.nightly.columns.source') }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in committed"
                :key="row.key"
                data-testid="baseline-row"
              >
                <th scope="row">
                  {{ row.pack }}
                </th>
                <td class="lb10-mono">
                  {{ row.alias }}
                </td>
                <td class="lb10-num">
                  {{ row.score }}
                </td>
                <td class="lb10-num">
                  {{ row.interval }}
                </td>
                <td class="lb10-num">
                  {{ row.cases }}
                </td>
                <td class="lb10-num">
                  {{ row.measured }}
                </td>
                <td>{{ row.source }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </section>
</template>
