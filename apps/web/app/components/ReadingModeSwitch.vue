<script setup lang="ts">
// <ReadingModeSwitch>: the Technical / Brief switch that the datasheets and the evaluation boards
// share. The choice lives in the reading store and is remembered between visits, so a visitor who
// prefers the 30-second Brief version keeps it on every page.
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useReadingStore } from '~/stores/reading'
import type { ReadingMode } from '~/stores/reading'

const { t } = useI18n()
const { mode } = storeToRefs(useReadingStore())
const options = computed<{ value: ReadingMode, label: string }[]>(() => [
  { value: 'technical', label: t('datasheet.technical') },
  { value: 'brief', label: t('datasheet.brief') },
])
</script>

<template>
  <div class="mode-row">
    <span
      class="lb-label"
      aria-hidden="true"
    >{{ t('datasheet.readingMode') }}</span>
    <LbSegmented
      v-model="mode"
      :options="options"
      :label="t('datasheet.readingMode')"
    />
  </div>
</template>

<style scoped>
.mode-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
</style>
