<script setup lang="ts">
// <AllCases>: table 2 of the report, every case of the sample and whether each prompt passed it on each provider, so
// the cases that did not change can be read too. A call that got no answer is said as such, not as a plain failure.
// The Technical reading shows it; the Brief reading keeps the changed cases alone.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Lb10Report, Lb10TargetCase } from '../schemas'
import { useLb10Words } from '../words'

const props = defineProps<{
  report: Lb10Report
  /** The target's sample, for each case's difficulty, when it is the same version of the pack. */
  sample: readonly Lb10TargetCase[] | undefined
}>()

const { t } = useI18n()
const words = useLb10Words()

const columns = computed(() => props.report.variants.map(variant => ({
  key: `${variant.provider}-${variant.variant}`,
  title: `${words.providerName(variant.provider)}, ${variant.variant === 'production' ? t('lb10.report.productionInSentence') : t('lb10.report.editedInSentence')}`,
  variant,
})))
const rows = computed(() => props.report.case_ids.map((caseId) => {
  const difficulty = props.sample?.find(item => item.id === caseId)?.difficulty
  return {
    caseId,
    difficulty: difficulty === undefined ? '–' : words.difficultyWord(difficulty),
    cells: columns.value.map((column) => {
      const outcome = column.variant.cases.find(item => item.case_id === caseId)
      if (!outcome) return { key: column.key, text: '–', passed: undefined }
      if (outcome.error !== null) return { key: column.key, text: t('lb10.report.all.noAnswer'), passed: false }
      return { key: column.key, text: outcome.passed ? t('lb10.report.all.passed') : t('lb10.report.all.failed'), passed: outcome.passed }
    }),
  }
}))
</script>

<template>
  <section
    class="all"
    data-testid="all-cases"
  >
    <div
      class="lb10-table-wrap"
      tabindex="0"
      role="group"
      :aria-label="t('lb10.report.all.caption')"
    >
      <table class="lb10-table">
        <caption>{{ t('lb10.report.all.caption') }}</caption>
        <thead>
          <tr>
            <th scope="col">
              {{ t('lb10.report.all.case') }}
            </th>
            <th scope="col">
              {{ t('lb10.report.all.difficulty') }}
            </th>
            <th
              v-for="column in columns"
              :key="column.key"
              scope="col"
            >
              {{ column.title }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.caseId"
          >
            <th
              scope="row"
              class="lb10-mono"
            >
              {{ row.caseId }}
            </th>
            <td>{{ row.difficulty }}</td>
            <td
              v-for="cell in row.cells"
              :key="cell.key"
              :data-passed="cell.passed"
            >
              {{ cell.text }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.all {
  min-width: 0;
}
</style>
