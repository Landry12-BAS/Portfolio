<script setup lang="ts">
// <DuplicatePanel>: whether the document is one the visitor, or the samples, already have. A document's
// identity is its vendor and its invoice number (cleaned of spaces, capitals and punctuation) and a hash
// of its content; the same vendor and number as a document already seen is a duplicate, and whether the
// content matches says which kind: the same invoice again, or a number reused for something that differs.
// The panel says what the comparison found in words, how many documents it compared with, and that a
// duplicate stops the export so the same invoice is not paid twice. The comparison is done by the service;
// this shows its verdict.
import { LbIcon } from '@lb/icons'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { LB03_SAMPLES } from '#shared/data/samples/lb03'

import type { Check, DocumentSummary, InvoiceDocument } from '../schemas'

const props = defineProps<{
  /** The document the service found this one to repeat, if it did. */
  duplicate: InvoiceDocument['duplicate']
  /** The `not_duplicate` check's verdict, which says when the comparison could not be made. */
  check: Check | undefined
  /** How many documents the comparison looked at, from the step the service recorded. */
  compared: number | undefined
  /** The visitor's documents of the hour, so a duplicate of one of them can be named by its file. */
  known: readonly DocumentSummary[]
}>()

const { t } = useI18n()

const sampleIds: ReadonlySet<string> = new Set(LB03_SAMPLES.map(sample => sample.id))

/** What the comparison came to: a duplicate, no duplicate, or no comparison. */
const verdict = computed<'duplicate' | 'none' | 'skipped'>(() => {
  if (props.duplicate !== null) return 'duplicate'
  return props.check?.status === 'skipped' ? 'skipped' : 'none'
})

/** Names what the document repeats: a sample by its title, one of the visitor's documents by its file name. */
const repeats = computed(() => {
  const found = props.duplicate
  if (found === null) return undefined
  if (found.source === 'sample') return sampleIds.has(found.of) ? t(`lb03.samples.${found.of}.title`) : found.of
  return props.known.find(item => item.id === found.of)?.label ?? t('lb03.duplicates.anotherDocument')
})
</script>

<template>
  <section
    class="duplicates"
    :aria-label="t('lb03.duplicates.title')"
    :data-verdict="verdict"
    data-testid="duplicates"
  >
    <h3 class="lb-label">
      {{ t('lb03.duplicates.title') }}
    </h3>
    <p class="rule">
      {{ t('lb03.duplicates.rule') }}
    </p>
    <div
      class="verdict"
      data-testid="duplicate-verdict"
    >
      <LbIcon
        :name="verdict === 'duplicate' ? 'error' : verdict === 'none' ? 'success' : 'info'"
        :size="18"
        tone="mono"
      />
      <div class="said">
        <template v-if="duplicate">
          <p class="head">
            {{ duplicate.source === 'sample' ? t('lb03.duplicates.ofSample', { name: repeats ?? '' }) : t('lb03.duplicates.ofDocument', { name: repeats ?? '' }) }}
          </p>
          <p
            class="text"
            data-testid="duplicate-kind"
          >
            {{ duplicate.same_content ? t('lb03.duplicates.sameContent') : t('lb03.duplicates.differentContent') }}
          </p>
          <p class="text muted">
            {{ t('lb03.duplicates.stops') }}
          </p>
        </template>
        <template v-else-if="verdict === 'skipped'">
          <p class="head">
            {{ t('lb03.duplicates.skipped') }}
          </p>
        </template>
        <template v-else>
          <p class="head">
            {{ t('lb03.duplicates.none') }}
          </p>
          <p
            v-if="compared !== undefined"
            class="text muted"
            data-testid="compared"
          >
            {{ t('lb03.duplicates.compared', { count: compared }) }}
          </p>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.duplicates {
  display: grid;
  gap: 8px;
  align-content: start;
  min-width: 0;
}

.rule {
  font-size: 13px;
  color: var(--lb-graphite);
}

.verdict {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  background: var(--lb-shade);
  border: 1.5px solid var(--lb-rule);
}

.duplicates[data-verdict="duplicate"] .verdict {
  border-color: var(--lb-ink);
}

.said {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.head {
  font-size: 14px;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.text {
  font-size: 13.5px;
}

.muted {
  font-size: 12.5px;
  color: var(--lb-graphite);
}
</style>
