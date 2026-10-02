<script setup lang="ts">
// <ReportSummary>: what the review did, beside what it found: how many quotes the model proposed and the
// server checked against the contract's text, how many it kept and how many it dropped and why (a dropped
// finding is counted and never shown), what the injection screen made of the contract, how many model
// calls the review used, and whether the second model's rating could be used. These are the figures that
// make "every finding quotes the contract" a claim a reader can weigh. The Brief reading keeps a sentence.
import { LB04_DROP_REASONS } from '@lb/contracts'
import type { Lb04Report } from '@lb/contracts'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { formatCount } from '~/board-kit/format'

const props = defineProps<{
  report: Lb04Report
  brief: boolean
}>()

const { t, locale } = useI18n()

const verification = computed(() => props.report.verification)
const dropped = computed(() => LB04_DROP_REASONS.filter(reason => (verification.value.reasons[reason] ?? 0) > 0).map(reason => ({ reason, count: verification.value.reasons[reason] ?? 0 })))
</script>

<template>
  <section
    class="lb4-section"
    aria-labelledby="lb4-summary-heading"
    data-testid="report-summary"
  >
    <h2 id="lb4-summary-heading">
      {{ t('lb04.summary.title') }}
    </h2>

    <p
      v-if="brief"
      class="lead"
    >
      {{ t('lb04.summary.brief', { kept: verification.kept, checked: verification.checked, calls: report.calls }) }}
      {{ report.screen.verdict === 'flagged' ? t('lb04.summary.flaggedShort') : '' }}
    </p>

    <dl
      v-else
      class="facts"
    >
      <div>
        <dt>{{ t('lb04.summary.quotes') }}</dt>
        <dd class="lb4-nums">
          {{ t('lb04.summary.quotesValue', { checked: formatCount(verification.checked, locale), kept: formatCount(verification.kept, locale), dropped: formatCount(verification.dropped, locale) }) }}
        </dd>
      </div>
      <div v-if="dropped.length > 0">
        <dt>{{ t('lb04.summary.droppedWhy') }}</dt>
        <dd>
          <ul class="reasons">
            <li
              v-for="entry in dropped"
              :key="entry.reason"
            >
              {{ t(`lb04.drops.${entry.reason}`) }}: <span class="lb4-nums">{{ entry.count }}</span>
            </li>
          </ul>
        </dd>
      </div>
      <div>
        <dt>{{ t('lb04.summary.screen') }}</dt>
        <dd data-testid="screen-verdict">
          {{ t(`lb04.screen.${report.screen.verdict}`, { count: report.screen.passageCount }) }}
        </dd>
      </div>
      <div>
        <dt>{{ t('lb04.summary.calls') }}</dt>
        <dd class="lb4-nums">
          {{ report.calls }}
        </dd>
      </div>
      <div>
        <dt>{{ t('lb04.summary.rating') }}</dt>
        <dd>{{ report.calibrated ? t('lb04.summary.rated') : t('lb04.summary.notRated') }}</dd>
      </div>
      <div>
        <dt>{{ t('lb04.summary.playbook') }}</dt>
        <dd class="lb4-nums">
          {{ t('lb04.summary.playbookValue', { version: report.playbookVersion }) }}
        </dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.lead {
  max-width: 70ch;
  font-size: 14.5px;
}

.facts {
  display: grid;
  gap: 8px;
  margin: 0;
}

.facts > div {
  display: grid;
  grid-template-columns: minmax(130px, 200px) minmax(0, 1fr);
  gap: 4px 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--lb-rule);
}

dt {
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

dd {
  margin: 0;
  font-size: 14px;
}

.reasons {
  padding: 0;
  margin: 0;
  list-style: none;
}

@media (max-width: 520px) {
  .facts > div {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
