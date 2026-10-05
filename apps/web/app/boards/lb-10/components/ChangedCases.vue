<script setup lang="ts">
// <ChangedCases>: every case whose grade changed between production's prompt and the visitor's, provider by provider,
// each with both replies and what every grader said (ChangedCase). A provider on which no case changed says so: the two
// prompts passed and failed the same cases there. The first cases of a provider show their replies at once and the rest
// open on a click, since an edit that breaks a prompt can change every case, and twenty open cases are a long page.
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Lb10Comparison } from '../schemas'
import { useLb10Words } from '../words'
import ChangedCase from './ChangedCase.vue'

const props = defineProps<{
  comparisons: readonly Lb10Comparison[]
  /** What the target answers with, which says whether a reply must hold a JSON object. */
  output: 'json' | 'text' | 'tool_calls'
}>()

const { t } = useI18n()
const words = useLb10Words()
const id = useId()

// How many cases of a provider show their replies when the report opens.
const OPEN_CASES = 2

const groups = computed(() => props.comparisons.map(comparison => ({
  key: comparison.provider,
  name: words.providerName(comparison.provider),
  changed: comparison.changed,
})))
</script>

<template>
  <section
    class="lb10-section"
    :aria-labelledby="`${id}-title`"
    data-testid="changed-cases"
  >
    <h3
      :id="`${id}-title`"
      class="lb10-subtitle"
    >
      {{ t('lb10.report.changed.title') }}
    </h3>
    <div
      v-for="group in groups"
      :key="group.key"
      class="group"
      :data-provider="group.key"
    >
      <h4 class="group-name">
        {{ t('lb10.report.changed.on', { provider: group.name }) }}
      </h4>
      <p
        v-if="group.changed.length === 0"
        class="lb10-hint"
        data-testid="none-changed"
      >
        {{ t('lb10.report.changed.none', { provider: group.name }) }}
      </p>
      <ChangedCase
        v-for="(change, index) in group.changed"
        :key="change.case_id"
        :change="change"
        :output="output"
        :open="index < OPEN_CASES"
      />
    </div>
  </section>
</template>

<style scoped>
.group {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.group-name {
  font-size: 13.5px;
  font-weight: 700;
}
</style>
