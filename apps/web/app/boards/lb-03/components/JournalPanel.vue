<script setup lang="ts">
// <JournalPanel>: the accounting entry the document makes. Code, not the model, posts it: the payable
// (or the cash, for a receipt) against the expense accounts the chart of accounts maps the line items to,
// the VAT to the input-VAT account, and a rounding line when a cent is left over, so that debit equals
// credit. The chart is a file of rules, and the entry is balanced to the cent in decimal arithmetic. A
// document that fails a check which stops the export makes no entry, and the panel says so, because an
// entry made from a document that does not add up would only be a bookkeeper's trap.
import { LbIcon } from '@lb/icons'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { InvoiceDocument } from '../schemas'

const props = defineProps<{
  /** The entry, or null when none was made. */
  journal: InvoiceDocument['journal']
  /** Why there is an entry or not. */
  status: InvoiceDocument['journal_status']
}>()

const { t } = useI18n()

// The two sides of a made entry agree to the cent: they are decimal strings of two places, so equal text is equal money.
const balanced = computed(() => props.journal !== null && props.journal.total_debit === props.journal.total_credit)
</script>

<template>
  <section
    class="journal"
    :aria-label="t('lb03.journal.title')"
    :data-status="status ?? 'none'"
    data-testid="journal"
  >
    <h3 class="lb-label">
      {{ t('lb03.journal.title') }}
    </h3>
    <template v-if="journal">
      <p class="about">
        {{ t('lb03.journal.about', { reference: journal.reference, date: journal.date, currency: journal.currency }) }}
      </p>
      <div class="scroll">
        <table class="table">
          <caption class="lb-sr-only">
            {{ t('lb03.journal.caption') }}
          </caption>
          <thead>
            <tr>
              <th scope="col">
                {{ t('lb03.journal.columns.account') }}
              </th>
              <th scope="col">
                {{ t('lb03.journal.columns.name') }}
              </th>
              <th
                scope="col"
                class="amount"
              >
                {{ t('lb03.journal.columns.debit') }}
              </th>
              <th
                scope="col"
                class="amount"
              >
                {{ t('lb03.journal.columns.credit') }}
              </th>
              <th scope="col">
                {{ t('lb03.journal.columns.memo') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(line, index) in journal.lines"
              :key="`${line.account}-${index}`"
              data-testid="journal-line"
            >
              <th scope="row">
                <code>{{ line.account }}</code>
              </th>
              <td>{{ line.name }}</td>
              <td class="amount">
                {{ line.debit }}
              </td>
              <td class="amount">
                {{ line.credit }}
              </td>
              <td class="memo">
                {{ line.memo }}
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr data-testid="journal-totals">
              <th
                scope="row"
                colspan="2"
              >
                {{ t('lb03.journal.totals') }}
              </th>
              <td class="amount">
                {{ journal.total_debit }}
              </td>
              <td class="amount">
                {{ journal.total_credit }}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p
        class="balance"
        data-testid="journal-balance"
      >
        <LbIcon
          :name="balanced ? 'success' : 'error'"
          :size="16"
          tone="mono"
        />
        {{ balanced ? t('lb03.journal.balanced') : t('lb03.journal.unbalanced') }}
      </p>
    </template>
    <p
      v-else
      class="none"
      data-testid="journal-none"
    >
      <LbIcon
        name="info"
        :size="16"
        tone="mono"
      />
      {{ status === 'blocked_by_checks' ? t('lb03.journal.blocked') : status === 'does_not_balance' ? t('lb03.journal.doesNotBalance') : t('lb03.journal.noEntry') }}
    </p>
  </section>
</template>

<style scoped>
.journal {
  display: grid;
  gap: 8px;
  align-content: start;
  min-width: 0;
}

.about {
  font-size: 13px;
  color: var(--lb-graphite);
}

.scroll {
  max-width: 100%;
  overflow-x: auto;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.table th,
.table td {
  padding: 5px 8px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--lb-rule);
}

.table thead th {
  font-family: var(--lb-font-mono);
  font-size: 10.5px;
  font-weight: 400;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--lb-graphite);
  border-bottom: 1.5px solid var(--lb-ink);
}

.table tfoot th,
.table tfoot td {
  font-weight: 700;
  border-top: 1.5px solid var(--lb-ink);
  border-bottom: 0;
}

.amount {
  font-family: var(--lb-font-mono);
  font-variant-numeric: tabular-nums;
  text-align: right !important;
  white-space: nowrap;
}

.memo {
  font-size: 12px;
  color: var(--lb-graphite);
  overflow-wrap: anywhere;
}

.balance,
.none {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 13px;
}

.none {
  padding: 10px 12px;
  background: var(--lb-shade);
  border: 1.5px solid var(--lb-rule);
}
</style>
