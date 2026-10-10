<script setup lang="ts">
// <ChecksPanel>: the validation checklist. Code, not the model, does the arithmetic: eleven checks run in
// a fixed order (the fields are all there, the dates are plausible, the currency is one the company
// trades in, the signs agree, each line's quantity times price is its total, the lines add up, the VAT is
// its rate times its base, the bases add up, the subtotal plus the VAT is the total, every value was found
// on the page, and the document is not a duplicate). Each is shown with what became of it in words and an
// icon (passed, failed and stops the export, a warning, not run), and a failed one says in a sentence what
// disagreed, with the numbers, and where: its fields are buttons that light their boxes on the page. A
// document that fails a check is never silently fixed; it is shown with the check that failed.
import { LbIcon } from '@lb/icons'
import type { IconName } from '@lb/icons'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { inCheckOrder, sentenceFor, tally } from '../checks'
import { fieldAt, fieldLabel } from '../fields'
import type { Check, Field } from '../schemas'

/** How many of a failed check's fields are offered as buttons; a check such as "found on the page" may name dozens. */
const MOST_FIELDS_SHOWN = 6

const props = defineProps<{
  /** The checks the service ran. */
  checks: readonly Check[]
  /** The document's fields, so a failed check's fields can be found and shown. */
  fields: readonly Field[]
  /** The path of the field the visitor is looking at. */
  selected: string | undefined
}>()

const emit = defineEmits<{ select: [path: string] }>()

const { t, locale } = useI18n()

const ordered = computed(() => inCheckOrder(props.checks))
const count = computed(() => tally(props.checks))

/** Chooses the icon that goes with what became of a check. */
function iconFor(check: Check): IconName {
  if (check.status === 'passed') return 'success'
  if (check.status === 'skipped') return 'info'
  return check.severity === 'error' ? 'error' : 'warning'
}

/** Says what became of a check, in words: passed, failed and stops the export, a warning, or not run. */
function statusFor(check: Check): string {
  if (check.status === 'passed') return t('lb03.checks.status.passed')
  if (check.status === 'skipped') return t('lb03.checks.status.skipped')
  return check.severity === 'error' ? t('lb03.checks.status.failed') : t('lb03.checks.status.warning')
}

/** Writes the sentence that tells a failed check, with the fields it is about named in the visitor's language. */
function sentence(check: Check): string {
  const told = sentenceFor(check)
  const labels = check.fields.slice(0, MOST_FIELDS_SHOWN).map(path => fieldLabel(path, t))
  const list = new Intl.ListFormat(locale.value, { style: 'long', type: 'conjunction' }).format(labels)
  return t(told.key, { ...told.values, fields: check.fields.length > MOST_FIELDS_SHOWN ? `${list}, …` : list })
}

/** The fields a failed check is about that are in the table, and so can be shown on the page. */
function showable(check: Check): string[] {
  if (check.status !== 'failed') return []
  return check.fields.filter(path => fieldAt(props.fields, path) !== undefined).slice(0, MOST_FIELDS_SHOWN)
}
</script>

<template>
  <section
    class="checks"
    :aria-label="t('lb03.checks.title')"
    data-testid="checks"
  >
    <h3 class="lb-label">
      {{ t('lb03.checks.title') }}
    </h3>
    <p
      class="summary"
      data-testid="checks-summary"
    >
      {{ t('lb03.checks.summary', { passed: count.passed, errors: count.errors, warnings: count.warnings, skipped: count.skipped }) }}
    </p>
    <ul class="list">
      <li
        v-for="check in ordered"
        :key="check.id"
        class="check"
        :data-status="check.status"
        :data-severity="check.status === 'failed' ? check.severity : undefined"
        :data-check="check.id"
        data-testid="check"
      >
        <span
          class="icon"
          aria-hidden="true"
        >
          <LbIcon
            :name="iconFor(check)"
            :size="18"
            tone="mono"
          />
        </span>
        <div class="body">
          <p class="head">
            <span class="name">{{ t(`lb03.checks.names.${check.id}`) }}</span>
            <span
              class="status"
              data-testid="check-status"
            >{{ statusFor(check) }}</span>
          </p>
          <p
            v-if="check.status === 'failed'"
            class="sentence"
            data-testid="check-sentence"
          >
            {{ sentence(check) }}
          </p>
          <p
            v-else-if="check.status === 'skipped'"
            class="sentence muted"
          >
            {{ t('lb03.checks.skippedBecause') }}
          </p>
          <p
            v-if="showable(check).length > 0"
            class="links"
          >
            <span class="muted">{{ t('lb03.checks.showOnPage') }}</span>
            <button
              v-for="path in showable(check)"
              :key="path"
              type="button"
              class="link"
              :aria-pressed="path === selected ? 'true' : 'false'"
              data-testid="check-field"
              @click="emit('select', path)"
            >
              {{ fieldLabel(path, t) }}
            </button>
          </p>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.checks {
  display: grid;
  gap: 8px;
  align-content: start;
  min-width: 0;
}

.summary {
  font-size: 13px;
  color: var(--lb-graphite);
}

.list {
  display: grid;
  gap: 0;
  padding: 0;
  margin: 0;
  list-style: none;
}

.check {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--lb-rule);
}

.check[data-status="failed"][data-severity="error"] {
  background: var(--lb-shade);
  box-shadow: inset 3px 0 0 var(--lb-ink);
  padding-left: 8px;
}

.icon {
  display: inline-flex;
  padding-top: 1px;
}

.body {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.head {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  align-items: baseline;
  justify-content: space-between;
}

.name {
  font-size: 14px;
  font-weight: 700;
}

.status {
  font-family: var(--lb-font-mono);
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.sentence {
  font-size: 13.5px;
}

.muted {
  font-size: 12.5px;
  color: var(--lb-graphite);
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
}

.link {
  padding: 0;
  font: 600 12.5px/1.3 var(--lb-font-sans);
  color: var(--lb-ink);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-bottom: 1.5px dotted var(--lb-ink);
}

.link[aria-pressed="true"] {
  border-bottom-style: solid;
}
</style>
