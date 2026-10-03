<script setup lang="ts">
// <SeverityMark>: how serious a finding is, as a word and a row of four marks of which as many are
// filled as the severity weighs (low one, critical four). The word carries the meaning; the marks only
// make the weight easy to compare down a list, and they are hidden from assistive technology, which
// would read the word and then four meaningless shapes.
import { lb04SeverityWeight } from '@lb/contracts'
import type { Lb04Severity } from '@lb/contracts'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  severity: Lb04Severity
}>()

const { t } = useI18n()
const weight = computed(() => lb04SeverityWeight(props.severity))
</script>

<template>
  <span
    class="lb4-severity"
    :data-severity="severity"
  >
    <span
      class="lb4-pips"
      aria-hidden="true"
    >
      <span
        v-for="mark in 4"
        :key="mark"
        class="lb4-pip"
        :class="{ 'lb4-pip--on': mark <= weight }"
      />
    </span>
    <span>{{ t(`lb04.severities.${severity}`) }}</span>
  </span>
</template>
