<script setup lang="ts">
// <ReportPanel>: the report of a finished run, honest above all. The sentence that ten cases is a small sample comes
// first, then figure 1 (the share of cases each prompt passed with its interval) and table 1 (the same numbers and what
// each prompt cost, with the cached calls said as such), then figure 2 (the paired difference with production and the
// verdict in words), then every case that changed with both replies, and in the Technical reading table 2 (every case).
// An unchanged prompt ran once: its report has production's score alone and says there is nothing to compare.
import { storeToRefs } from 'pinia'
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLb10Store } from '../store'
import type { Lb10Report } from '../schemas'
import { useLb10Words } from '../words'
import AllCases from './AllCases.vue'
import ChangedCases from './ChangedCases.vue'
import DifferenceFigure from './DifferenceFigure.vue'
import ReportTable from './ReportTable.vue'
import ScoreFigure from './ScoreFigure.vue'

const props = defineProps<{
  report: Lb10Report
  /** The Brief reading keeps the figures, the verdicts and the changed cases, and leaves out table 2 and the pack's version. */
  brief: boolean
}>()

const { t } = useI18n()
const words = useLb10Words()
const { targets } = storeToRefs(useLb10Store())
const id = useId()

const target = computed(() => targets.value?.targets.find(item => item.pack === props.report.pack))
// The case's difficulties are the target's only when it is the version of the pack the run measured.
const sample = computed(() => (target.value?.version === props.report.pack_version ? target.value.sample : undefined))
const output = computed(() => target.value?.output ?? 'json')
const title = computed(() => words.packTitle(props.report.pack, target.value?.name))
</script>

<template>
  <section
    id="lb10-report"
    class="lb10-section report"
    :aria-labelledby="`${id}-title`"
    data-testid="report"
  >
    <h2 :id="`${id}-title`">
      {{ t('lb10.report.title') }}: {{ title }}
    </h2>
    <p
      v-if="!brief"
      class="lb10-hint lb10-mono"
      data-testid="report-pack"
    >
      {{ t('lb10.report.pack', { pack: report.pack, version: report.pack_version, cases: words.number(report.sample_size) }) }}
    </p>
    <p
      class="small-sample"
      data-testid="small-sample"
    >
      {{ t('lb10.report.smallSample') }}
    </p>
    <p
      v-if="report.edited_is_production"
      data-testid="unchanged-report"
    >
      {{ t('lb10.report.unchanged') }}
    </p>
    <ScoreFigure :report="report" />
    <ReportTable
      :report="report"
      :brief="brief"
    />
    <DifferenceFigure
      v-if="report.comparisons.length > 0"
      :comparisons="report.comparisons"
    />
    <ChangedCases
      v-if="report.comparisons.length > 0"
      :comparisons="report.comparisons"
      :output="output"
    />
    <AllCases
      v-if="!brief"
      :report="report"
      :sample="sample"
    />
  </section>
</template>

<style scoped>
.report {
  gap: 18px;
}
.small-sample {
  padding: 8px 10px;
  font-weight: 600;
  border-left: 3px solid var(--lb-ink);
  background: var(--lb-shade);
}
</style>
