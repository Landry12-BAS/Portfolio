<script setup lang="ts">
// <FieldsTable>: every field the reader found, in the order a person reads an invoice (the document's
// details, each line, the subtotal, each VAT line, the total), with its value, where it is on the page and
// how sure the reader is of it (a word and a percentage, and a meter of three segments that says the same
// as a shape), and the checks that failed on it. A name is a button that lights the field's box on the
// page. In a live reading a value can be corrected: Edit opens an input that fits the field (a choice for
// the kind of document, a date, an amount), Enter saves and Escape leaves, and the service answers with the
// whole document and every check run again. A value the service refuses stays open with the reason. A
// corrected field says so in words ("corrected"), and the corrections are listed under the table.
import { LbIcon } from '@lb/icons'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { BAND_SEGMENTS, confidencePercent } from '../boxes'
import { DOCUMENT_TYPES, KNOWN_CURRENCIES, fieldLabel, groupFields, labelKey } from '../fields'
import type { CorrectionRefusal } from '../refusals'
import type { Check, Correction, Field } from '../schemas'

const props = defineProps<{
  /** The document's fields. */
  fields: readonly Field[]
  /** The path of the field the visitor is looking at. */
  selected: string | undefined
  /** Whether values can be corrected: a live document that is read. */
  editable: boolean
  /** True while a correction is being sent. */
  busy: boolean
  /** Why the last correction was refused, if it was. */
  problem: CorrectionRefusal | undefined
  /** A sentence about what the last correction did, for the live region. */
  status: string
  /** The checks, so a failed one can be named by its id. */
  checks: readonly Check[]
  /** What the visitor has corrected, oldest first. */
  corrections: readonly Correction[]
}>()

const emit = defineEmits<{
  select: [path: string]
  correct: [path: string, value: string]
}>()

const { t } = useI18n()

const groups = computed(() => groupFields(props.fields))
// The field being edited, what is typed so far, and the field a correction was last sent for (its refusal belongs to that row).
const editing = ref<string>()
const draft = ref('')
const sentFor = ref<string>()
const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>()
const editButtons = new Map<string, HTMLButtonElement>()

const failedChecks = computed(() => new Set(props.checks.filter(check => check.status === 'failed').map(check => check.id)))

/** Keeps the input of a row, so it can be focused when the row opens. */
function holdInput(path: string, element: unknown): void {
  if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) inputs.set(path, element)
  else inputs.delete(path)
}

/** Keeps the Edit button of a row, so focus can go back to it when the row closes. */
function holdEditButton(path: string, element: unknown): void {
  if (element instanceof HTMLButtonElement) editButtons.set(path, element)
  else editButtons.delete(path)
}

/** Opens a field for correction and puts the cursor in its input. */
async function start(field: Field): Promise<void> {
  editing.value = field.path
  draft.value = field.value ?? ''
  sentFor.value = undefined
  emit('select', field.path)
  await nextTick()
  inputs.get(field.path)?.focus()
}

/** Closes the field being corrected and gives focus back to its Edit button. */
async function close(): Promise<void> {
  const path = editing.value
  editing.value = undefined
  sentFor.value = undefined
  if (path === undefined) return
  await nextTick()
  editButtons.get(path)?.focus()
}

/** Sends what was typed. The row stays open until the service has answered. */
function save(): void {
  const path = editing.value
  if (path === undefined || props.busy) return
  sentFor.value = path
  emit('correct', path, draft.value.trim())
}

// When a correction has been answered and not refused, the row closes; when it was refused, it stays open with the reason.
watch(() => props.busy, (now, before) => {
  if (before && !now && props.problem === undefined && editing.value !== undefined && sentFor.value === editing.value) void close()
})

// A document that is replaced by another (a new run) leaves nothing open.
watch(() => props.editable, (now) => {
  if (!now) editing.value = undefined
})

/** Gives the heading of a group of rows. */
function heading(group: { heading: { key: string, number: number | undefined } }): string {
  return t(group.heading.key, { n: group.heading.number ?? 0 })
}

/** Gives a field's own name, without its row, which the heading of its group says. */
function nameOf(field: Field): string {
  const key = labelKey(field.path)
  return key === undefined ? field.path : t(key)
}

/** Says what the field's confidence comes to in words, such as "High, 97%". */
function sureness(field: Field): string {
  if (field.box === null) return field.edited ? t('lb03.fields.typed') : t('lb03.fields.notFound')
  return t('lb03.fields.sure', { band: t(`lb03.confidence.band.${field.box.band}`), percent: confidencePercent(field.box) })
}

/** The checks that failed on a field, by name. */
function failedOn(field: Field): string[] {
  return field.checks.filter(id => failedChecks.value.has(id)).map(id => t(`lb03.checks.names.${id}`))
}

/** What to say for a field's value: the value, or that it is empty. */
function shown(field: Field): string {
  return field.value ?? t('lb03.fields.empty')
}

/** What the correction list says about one correction: the field, and what it was and became. */
function correctionText(item: Correction): string {
  return t('lb03.fields.corrected', {
    field: fieldLabel(item.path, t),
    was: item.was ?? t('lb03.fields.empty'),
    now: item.now ?? t('lb03.fields.empty'),
  })
}

/** The hint under an input: how this kind of value is written. */
function hintKey(field: Field): string {
  return `lb03.fields.hints.${field.kind}`
}

/** The attribute that brings up the right keyboard for a kind of value on a phone. */
function inputMode(field: Field): 'decimal' | 'numeric' | 'text' {
  if (field.kind === 'amount' || field.kind === 'quantity' || field.kind === 'rate') return 'decimal'
  return field.kind === 'date' ? 'numeric' : 'text'
}
</script>

<template>
  <div
    class="fields"
    data-testid="fields"
  >
    <p
      class="status"
      role="status"
      data-testid="fields-status"
    >
      {{ status }}
    </p>
    <div
      class="scroll"
      role="region"
      tabindex="0"
      :aria-label="t('lb03.fields.region')"
    >
      <table class="table">
        <caption class="lb-sr-only">
          {{ t('lb03.fields.caption') }}
        </caption>
        <thead>
          <tr>
            <th scope="col">
              {{ t('lb03.fields.columns.field') }}
            </th>
            <th scope="col">
              {{ t('lb03.fields.columns.value') }}
            </th>
            <th scope="col">
              {{ t('lb03.fields.columns.where') }}
            </th>
            <th scope="col">
              {{ t('lb03.fields.columns.checks') }}
            </th>
            <th scope="col">
              <span class="lb-sr-only">{{ t('lb03.fields.columns.actions') }}</span>
            </th>
          </tr>
        </thead>
        <tbody
          v-for="group in groups"
          :key="group.key"
        >
          <tr class="group">
            <th
              scope="rowgroup"
              colspan="5"
            >
              {{ heading(group) }}
            </th>
          </tr>
          <tr
            v-for="field in group.fields"
            :key="field.path"
            class="row"
            :class="{ chosen: field.path === selected }"
            :data-path="field.path"
            data-testid="field-row"
          >
            <th
              scope="row"
              class="name"
            >
              <button
                type="button"
                class="look"
                :aria-pressed="field.path === selected ? 'true' : 'false'"
                :aria-label="t('lb03.fields.look', { field: fieldLabel(field.path, t) })"
                data-testid="look"
                @click="emit('select', field.path)"
              >
                {{ nameOf(field) }}
              </button>
            </th>
            <td
              class="value"
              :data-label="t('lb03.fields.columns.value')"
            >
              <form
                v-if="editing === field.path"
                class="edit"
                @submit.prevent="save"
              >
                <select
                  v-if="field.kind === 'choice'"
                  :ref="element => holdInput(field.path, element)"
                  v-model="draft"
                  class="control"
                  :aria-label="t('lb03.fields.editLabel', { field: fieldLabel(field.path, t) })"
                  :aria-describedby="`hint-${group.key}-${field.path}`"
                  :disabled="busy"
                  data-testid="edit-input"
                  @keydown.esc.prevent="close"
                >
                  <option
                    v-for="type in DOCUMENT_TYPES"
                    :key="type"
                    :value="type"
                  >
                    {{ t(`lb03.documentTypes.${type}`) }}
                  </option>
                </select>
                <input
                  v-else
                  :ref="element => holdInput(field.path, element)"
                  v-model="draft"
                  class="control"
                  type="text"
                  :inputmode="inputMode(field)"
                  :maxlength="field.kind === 'currency' ? 3 : 160"
                  :list="field.kind === 'currency' ? 'lb03-currencies' : undefined"
                  autocomplete="off"
                  spellcheck="false"
                  :aria-label="t('lb03.fields.editLabel', { field: fieldLabel(field.path, t) })"
                  :aria-describedby="`hint-${group.key}-${field.path}`"
                  :aria-invalid="problem !== undefined && sentFor === field.path ? 'true' : undefined"
                  :disabled="busy"
                  data-testid="edit-input"
                  @keydown.esc.prevent="close"
                >
                <p
                  :id="`hint-${group.key}-${field.path}`"
                  class="hint"
                >
                  {{ t(hintKey(field)) }}
                </p>
                <p
                  v-if="problem !== undefined && sentFor === field.path"
                  class="problem"
                  role="alert"
                  data-testid="edit-problem"
                >
                  {{ t(`lb03.fields.problems.${problem}`) }}
                </p>
                <div class="buttons">
                  <button
                    type="submit"
                    class="button button--primary"
                    :disabled="busy"
                    data-testid="save-edit"
                    @keydown.esc.prevent="close"
                  >
                    {{ busy ? t('lb03.fields.saving') : t('lb03.fields.save') }}
                  </button>
                  <button
                    type="button"
                    class="button"
                    :disabled="busy"
                    data-testid="cancel-edit"
                    @click="close"
                    @keydown.esc.prevent="close"
                  >
                    {{ t('lb03.fields.cancel') }}
                  </button>
                </div>
              </form>
              <template v-else>
                <span
                  class="text"
                  :class="{ empty: field.value === null }"
                  data-testid="field-value"
                >{{ shown(field) }}</span>
                <span
                  v-if="field.edited"
                  class="tag"
                  data-testid="edited-tag"
                >{{ t('lb03.fields.edited') }}</span>
              </template>
            </td>
            <td
              class="where"
              :data-label="t('lb03.fields.columns.where')"
            >
              <span
                v-if="field.box"
                class="meter"
                aria-hidden="true"
              >
                <span
                  v-for="segment in 3"
                  :key="segment"
                  class="segment"
                  :class="{ on: segment <= BAND_SEGMENTS[field.box.band] }"
                />
              </span>
              <span
                class="sure"
                :data-band="field.box?.band"
                data-testid="sureness"
              >{{ sureness(field) }}</span>
            </td>
            <td
              class="checks"
              :data-label="t('lb03.fields.columns.checks')"
            >
              <ul
                v-if="failedOn(field).length > 0"
                class="failed"
              >
                <li
                  v-for="name in failedOn(field)"
                  :key="name"
                  class="failed-check"
                  data-testid="field-check"
                >
                  <LbIcon
                    name="error"
                    :size="14"
                    tone="mono"
                  />
                  {{ name }}
                </li>
              </ul>
            </td>
            <td class="actions">
              <button
                v-if="editable && editing !== field.path"
                :ref="element => holdEditButton(field.path, element)"
                type="button"
                class="button"
                :aria-label="t('lb03.fields.editField', { field: fieldLabel(field.path, t) })"
                data-testid="edit"
                @click="start(field)"
              >
                {{ t('lb03.fields.edit') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <datalist id="lb03-currencies">
      <option
        v-for="code in KNOWN_CURRENCIES"
        :key="code"
        :value="code"
      />
    </datalist>
    <section
      v-if="corrections.length > 0"
      class="corrections"
      :aria-label="t('lb03.fields.correctionsTitle')"
      data-testid="corrections"
    >
      <h3 class="lb-label">
        {{ t('lb03.fields.correctionsTitle') }}
      </h3>
      <ul>
        <li
          v-for="(item, index) in corrections"
          :key="`${item.path}-${index}`"
          data-testid="correction"
        >
          {{ correctionText(item) }}
        </li>
      </ul>
    </section>
    <p
      v-if="!editable"
      class="hint"
      data-testid="read-only"
    >
      {{ t('lb03.fields.readOnly') }}
    </p>
  </div>
</template>

<style scoped>
.fields {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.status {
  min-height: 1.4em;
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
  font-size: 13.5px;
}

.table th,
.table td {
  padding: 6px 8px;
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

.group th {
  padding-top: 12px;
  font-size: 12px;
  font-weight: 700;
  background: var(--lb-shade);
}

.row.chosen > * {
  background: var(--lb-board-tint);
}

.name {
  font-weight: 400;
}

.look {
  padding: 2px 0;
  font: 600 13.5px/1.3 var(--lb-font-sans);
  color: var(--lb-ink);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-bottom: 1.5px dotted var(--lb-ink);
}

.look[aria-pressed="true"] {
  border-bottom-style: solid;
}

.value {
  min-width: 140px;
}

.text {
  font-family: var(--lb-font-mono);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.text.empty {
  font-family: var(--lb-font-sans);
  font-style: italic;
  color: var(--lb-graphite);
}

.tag {
  display: inline-block;
  padding: 0 6px;
  margin-left: 8px;
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  border: 1.5px solid var(--lb-ink);
  border-radius: 999px;
}

.where {
  white-space: nowrap;
}

.meter {
  display: inline-flex;
  gap: 2px;
  margin-right: 6px;
  vertical-align: middle;
}

.segment {
  width: 8px;
  height: 8px;
  border: 1.5px solid var(--lb-ink);
}

.segment.on {
  background: var(--lb-ink);
}

.sure {
  font-size: 12.5px;
}

.failed {
  display: grid;
  gap: 2px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.failed-check {
  display: flex;
  gap: 4px;
  align-items: center;
  font-size: 12.5px;
  font-weight: 600;
}

.edit {
  display: grid;
  gap: 6px;
}

.control {
  width: 100%;
  min-width: 120px;
  padding: 6px 8px;
  font: 400 13.5px/1.4 var(--lb-font-mono);
  color: var(--lb-ink);
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}

.hint {
  font-size: 12px;
  color: var(--lb-graphite);
}

.problem {
  font-size: 12.5px;
  font-weight: 700;
}

.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.button {
  padding: 5px 12px;
  font: 600 12.5px/1.2 var(--lb-font-sans);
  color: var(--lb-ink);
  cursor: pointer;
  background: transparent;
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}

.button:hover:not(:disabled) {
  background: var(--lb-shade);
}

.button--primary {
  color: var(--lb-sheet);
  background: var(--lb-ink);
}

.button--primary:hover:not(:disabled) {
  background: var(--lb-ink-hover);
}

.button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.corrections {
  display: grid;
  gap: 4px;
  font-size: 13px;
}

.corrections ul {
  padding-left: 18px;
  margin: 0;
}

/* On a narrow screen each row is a card: the column's name goes in front of its value. */
@media (max-width: 720px) {
  .table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }

  .table,
  .table tbody,
  .table tr,
  .table th,
  .table td {
    display: block;
  }

  .row {
    padding: 6px 0;
    border-bottom: 1px solid var(--lb-rule);
  }

  .table th,
  .table td {
    padding: 2px 8px;
    border-bottom: 0;
  }

  .where {
    white-space: normal;
  }

  td[data-label]::before {
    display: block;
    font-family: var(--lb-font-mono);
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--lb-graphite);
    content: attr(data-label);
  }

  td.checks:not(:has(li))::before {
    display: none;
  }
}
</style>
