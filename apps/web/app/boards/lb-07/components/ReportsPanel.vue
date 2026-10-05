<script setup lang="ts">
// <ReportsPanel>: the bug reports, which a model wrote from the findings code made and code checked
// (a report that names a finding the run does not have is dropped, and counted). The panel says so before
// the first report, shows every report's words as plain English text (the model's), and links each to the
// findings it rests on. The severity is a word from a closed list, never a colour alone.
import { storeToRefs } from 'pinia'
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLb07Store } from '../store'
import { useLb07Words } from '../words'

const { t } = useI18n()
const words = useLb07Words()
const { report } = storeToRefs(useLb07Store())
const id = useId()

const reports = computed(() => report.value?.reports ?? [])
</script>

<template>
  <section
    v-if="report"
    class="lb7-panel"
    :aria-labelledby="`${id}-title`"
    data-testid="reports"
  >
    <h2 :id="`${id}-title`">
      {{ t('lb07.reports.title') }}
    </h2>
    <p
      v-if="reports.length === 0"
      data-testid="no-reports"
    >
      {{ t('lb07.reports.none') }}
    </p>
    <template v-else>
      <p
        class="by-model"
        data-testid="by-model"
      >
        {{ t('lb07.reports.byModel') }}
      </p>
      <article
        v-for="(item, index) in reports"
        :key="index"
        class="report"
        data-testid="report"
      >
        <h3
          class="title"
          lang="en"
        >
          {{ item.title }}
        </h3>
        <p class="severity">
          <span class="lb7-label">{{ t('lb07.reports.severity') }}</span>
          <strong :data-severity="item.severity">{{ words.severityWord(item.severity) }}</strong>
        </p>
        <p class="lb7-label">
          {{ t('lb07.reports.steps') }}
        </p>
        <ol
          class="report-steps"
          lang="en"
        >
          <li
            v-for="(step, stepIndex) in item.steps"
            :key="stepIndex"
          >
            {{ step }}
          </li>
        </ol>
        <dl class="pair">
          <div>
            <dt class="lb7-label">
              {{ t('lb07.reports.expected') }}
            </dt>
            <dd lang="en">
              {{ item.expected }}
            </dd>
          </div>
          <div>
            <dt class="lb7-label">
              {{ t('lb07.reports.actual') }}
            </dt>
            <dd lang="en">
              {{ item.actual }}
            </dd>
          </div>
        </dl>
        <p class="rests">
          <span class="lb7-label">{{ t('lb07.reports.rests') }}</span>
          <a
            v-for="finding in item.findingIds"
            :key="finding"
            class="lb7-link"
            :href="`#lb07-finding-${finding}`"
          >{{ t('lb07.findings.number', { number: finding.slice(1) }) }}</a>
        </p>
      </article>
    </template>
    <p
      v-if="report.reportsDropped > 0"
      class="lb7-hint"
    >
      {{ t('lb07.reports.dropped', { count: report.reportsDropped }) }}
    </p>
  </section>
</template>

<style scoped>
.by-model {
  padding: 8px 10px;
  font-size: 13px;
  background: var(--lb-shade);
  border-left: 3px solid var(--lb-ink);
}
.report {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--lb-rule);
}
.title {
  font-size: 14.5px;
  font-weight: 700;
  overflow-wrap: anywhere;
}
.severity,
.rests {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
}
.report-steps {
  display: grid;
  gap: 2px;
  padding-left: 22px;
  margin: 0;
  font-size: 13.5px;
}
.pair {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  gap: 8px 16px;
  margin: 0;
}
.pair dd {
  margin: 2px 0 0;
  font-size: 13.5px;
  overflow-wrap: anywhere;
}
</style>
