<script setup lang="ts">
// <ReadingCounters>: the numbers of the document on the board, from what the service reports of it: where
// it ended, how many pages it has, how many model calls it took of the five a document is given, how long it
// took in all and how much of that was the OCR, which model wrote the reading, how many checks failed, how
// many fields the visitor corrected, and when it is deleted. They are the service's counts and the board
// adds nothing to them. In the Brief reading only the first few are shown.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { formatDuration, formatMoment } from '~/board-kit/format'

import { tally } from '../checks'
import type { DocumentQuota, InvoiceDocument } from '../schemas'

const props = defineProps<{
  /** The document on the board, if there is one. */
  document: InvoiceDocument | undefined
  /** The limits the service enforces, which say how many model calls a document is given. */
  quota: DocumentQuota | undefined
  /** The Brief reading shows a few of the counters, the Technical one all of them. */
  brief: boolean
  /** True for a replay: its document is not the visitor's own, so it has no hour to live. */
  replaying: boolean
}>()

const { t, locale } = useI18n()

const counts = computed(() => (props.document?.checks ? tally(props.document.checks) : undefined))
const calls = computed(() => t('lb03.counters.callsOf', { calls: props.document?.model_calls ?? 0, max: props.quota?.limits.max_model_calls_per_document ?? 5 }))
</script>

<template>
  <section
    class="counters"
    :aria-label="t('lb03.counters.title')"
    data-testid="counters"
  >
    <h2 class="lb-label">
      {{ t('lb03.counters.title') }}
    </h2>
    <p
      v-if="!document"
      class="none"
    >
      {{ t('lb03.counters.none') }}
    </p>
    <dl
      v-else
      class="list"
    >
      <div class="row">
        <dt>{{ t('lb03.counters.state') }}</dt>
        <dd data-testid="counter-state">
          {{ t(`lb03.state.${document.state}`) }}
        </dd>
      </div>
      <div
        v-if="document.pages !== null"
        class="row"
      >
        <dt>{{ t('lb03.counters.pages') }}</dt>
        <dd>{{ document.pages }}</dd>
      </div>
      <div
        v-if="document.elapsed_ms !== null"
        class="row"
      >
        <dt>{{ t('lb03.counters.time') }}</dt>
        <dd data-testid="counter-time">
          {{ formatDuration(document.elapsed_ms, locale) }}
        </dd>
      </div>
      <div
        v-if="counts"
        class="row"
      >
        <dt>{{ t('lb03.counters.checks') }}</dt>
        <dd data-testid="counter-checks">
          {{ t('lb03.counters.checksOf', { failed: counts.errors + counts.warnings, total: document.checks?.length ?? 0 }) }}
        </dd>
      </div>
      <div class="row">
        <dt>{{ t('lb03.counters.corrections') }}</dt>
        <dd data-testid="counter-corrections">
          {{ document.corrections.length }}
        </dd>
      </div>
      <template v-if="!brief">
        <div class="row">
          <dt>{{ t('lb03.counters.calls') }}</dt>
          <dd data-testid="counter-calls">
            {{ calls }}
          </dd>
        </div>
        <div
          v-if="document.ocr_ms !== null"
          class="row"
        >
          <dt>{{ t('lb03.counters.ocr') }}</dt>
          <dd>{{ formatDuration(document.ocr_ms, locale) }}</dd>
        </div>
        <div
          v-if="document.model"
          class="row"
        >
          <dt>{{ t('lb03.counters.model') }}</dt>
          <dd class="model">
            {{ document.model }}
          </dd>
        </div>
        <div
          v-if="document.text_cut"
          class="row"
        >
          <dt>{{ t('lb03.counters.textCut') }}</dt>
          <dd>{{ t('lb03.counters.textCutYes') }}</dd>
        </div>
        <div
          v-if="!replaying"
          class="row"
        >
          <dt>{{ t('lb03.counters.expires') }}</dt>
          <dd>{{ formatMoment(document.expires_at, locale) }}</dd>
        </div>
      </template>
    </dl>
  </section>
</template>

<style scoped>
.counters {
  display: grid;
  gap: 8px;
}

.none {
  font-size: 13px;
  color: var(--lb-graphite);
}

.list {
  display: grid;
  gap: 4px;
  margin: 0;
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
  align-items: baseline;
  justify-content: space-between;
  font-size: 13.5px;
}

.row dt {
  color: var(--lb-graphite);
}

.row dd {
  margin: 0;
  font-family: var(--lb-font-mono);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.model {
  overflow-wrap: anywhere;
}
</style>
