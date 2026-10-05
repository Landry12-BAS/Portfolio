<script setup lang="ts">
// <FailurePanel>: why a run failed, in the board's own words for the service's failure code (the model out
// of reach, a plan the system could not accept or refused, the sandbox out of reach, the three minutes used,
// the goal refused), and what that means for the visitor's day: a failure that was the system's doing gives
// the run back, as the service does, and any other still counts. A failed run has no report and no test.
import { LbIcon } from '@lb/icons'
import { storeToRefs } from 'pinia'
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { GIVEN_BACK } from '../run'
import { useLb07Store } from '../store'
import { useLb07Words } from '../words'

const { t } = useI18n()
const words = useLb07Words()
const { run, runMode } = storeToRefs(useLb07Store())
const id = useId()

const failure = computed(() => (run.value?.state === 'failed' ? run.value.failure : null))
</script>

<template>
  <section
    v-if="failure"
    class="lb7-panel failure"
    role="alert"
    :aria-labelledby="`${id}-title`"
    data-testid="failure"
    :data-code="failure.code"
  >
    <h2
      :id="`${id}-title`"
      class="title"
    >
      <LbIcon
        name="error"
        :size="18"
        tone="mono"
      />
      <span>{{ t('lb07.failures.title') }}</span>
    </h2>
    <p data-testid="failure-text">
      {{ words.failureText(failure.code) }}
    </p>
    <p
      v-if="runMode === 'live'"
      data-testid="failure-day"
    >
      {{ GIVEN_BACK.has(failure.code) ? t('lb07.failures.givenBack') : t('lb07.failures.counted') }}
    </p>
    <p class="lb7-hint">
      {{ t('lb07.failures.noReport') }}
    </p>
  </section>
</template>

<style scoped>
.failure {
  border-left: 3px solid var(--lb-ink);
}
.title {
  display: flex;
  gap: 8px;
  align-items: center;
  font-family: var(--lb-font-sans);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: none;
  color: var(--lb-ink);
}
</style>
