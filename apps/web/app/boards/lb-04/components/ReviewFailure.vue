<script setup lang="ts">
// <ReviewFailure>: what the board says when a review ended without a report. The reason is a code the
// service gives, and the words for each are the board's own, in the visitor's language, never the
// service's sentence. Most reasons are the file's own: a scan has no text layer and no OCR is done, a
// file over the page limit is not read, an encrypted file cannot be opened. Those, and a model that could
// not be reached, give the visitor's place for the day back, and the notice says so; the files sent
// are counted either way, since reading a stranger's file is work. A failed review keeps no file and no
// text: the service deletes both at once.
import type { Lb04FailureCode } from '@lb/contracts'
import { LbIcon } from '@lb/icons'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  code: Lb04FailureCode
  /** Whether this is a recording being replayed, which took nothing from the visitor's day and has nothing to give back. */
  replaying: boolean
  /** The number of pages the sample or the file has, for the reasons that are about length. */
  limit: number
}>()

const { t } = useI18n()

// A model that could not be reached, or answered in no usable form, is nothing the visitor's file did, and is worth trying again later.
const retryable = computed(() => props.code === 'analysis_unavailable' || props.code === 'analysis_invalid' || props.code === 'internal')
</script>

<template>
  <div
    class="failure"
    role="alert"
    data-testid="failure"
    :data-code="code"
  >
    <LbIcon
      name="warning"
      :size="20"
    />
    <div class="body">
      <p class="title">
        {{ t('lb04.failure.title') }}
      </p>
      <p class="text">
        {{ t(`lb04.failure.codes.${code}`, { limit }) }}
      </p>
      <p class="text">
        {{ retryable ? t('lb04.failure.tryLater') : t('lb04.failure.tryAnother') }}
      </p>
      <p
        v-if="!replaying"
        class="text given-back"
      >
        {{ t('lb04.failure.givenBack') }}
      </p>
    </div>
  </div>
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
  max-width: 70ch;
  font-size: 14px;
}
</style>
