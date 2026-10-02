<script setup lang="ts">
// <ReadFailure>: what the board says about a document that has no result. A document fails for one of
// sixteen reasons, which the service names with a code; the board has its own sentence for each, in the
// visitor's language, and says whether the document is given back to the day's count (the service's own
// failures are, a few a day, because trying again later may work; a file that cannot be read is not).
// For a document stopped by the injection check, it also says what the check found, because that is the
// point of the sample: the text of the page tried to give orders, so no model was ever shown it.
import { LbIcon } from '@lb/icons'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { REFUNDS_PER_DAY, isServiceFailure } from '../failures'
import type { InvoiceDocument } from '../schemas'

const props = defineProps<{
  /** The document that ended with no result. */
  document: InvoiceDocument
  /** True for a replay, whose document is not the visitor's own and was never counted. */
  replaying: boolean
}>()

const { t, n } = useI18n()

const code = computed(() => props.document.failure?.code)
// What the injection check found, from the step it recorded: how many segments of the text it read, and the highest score it gave.
const guardStep = computed(() => props.document.steps.find(step => step.name === 'injection check'))
const score = computed(() => {
  const value = guardStep.value?.detail.score
  return typeof value === 'number' ? n(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : undefined
})
</script>

<template>
  <section
    v-if="code"
    class="failure"
    role="status"
    :data-code="code"
    data-testid="failure"
  >
    <LbIcon
      name="warning"
      :size="20"
    />
    <div class="body">
      <p class="title">
        {{ t('lb03.failure.title') }}
      </p>
      <p class="text">
        {{ t(`lb03.failure.codes.${code}`) }}
      </p>
      <p
        v-if="code === 'injection_suspected' && score"
        class="text"
        data-testid="guard-score"
      >
        {{ t('lb03.failure.guardScore', { score }) }}
      </p>
      <p
        v-if="!replaying"
        class="text note"
        data-testid="refund"
      >
        {{ isServiceFailure(code) ? t('lb03.failure.givenBack', { count: REFUNDS_PER_DAY }) : t('lb03.failure.counted') }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.failure {
  display: flex;
  gap: 12px;
  padding: 12px 14px;
  background: var(--lb-shade);
  border: 1.5px solid var(--lb-ink);
}

.body {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.title {
  font-weight: 700;
}

.text {
  font-size: 14px;
}

.note {
  font-size: 12.5px;
  color: var(--lb-graphite);
}
</style>
