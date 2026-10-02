<script setup lang="ts">
// <ParamField>: one input of the inspector, drawn from a field the generator made out of the step's
// schema (graph/form.ts): a list to choose from, a text box, or rows of names and values. It knows
// nothing about connectors. The field's name and hint come from the locale files by the step's
// owner and the field's name, a text that may hold values offers to insert one, and a problem is
// shown as words beside the input and tied to it for screen readers.
import { LbIcon } from '@lb/icons'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { FormField } from '../graph/form'
import type { ReferenceOption } from '../graph/references'

const props = defineProps<{
  field: FormField
  /** What owns the field: a connector's id, `trigger` or `approval`. */
  owner: string
  value: unknown
  /** The values a text of the step may hold, in the order to offer them. */
  references: readonly ReferenceOption[]
  /** The names of the steps the values come from, by id. */
  sources: Readonly<Record<string, string>>
  /** Words about a problem with this field, or nothing. */
  error: string | undefined
  /** Makes the ids of this field unique on the page. */
  idPrefix: string
}>()

const emit = defineEmits<{ change: [value: unknown] }>()

const { t, te } = useI18n()

const inputId = computed(() => `${props.idPrefix}-${props.field.name}`)
const hintId = computed(() => `${inputId.value}-hint`)
const errorId = computed(() => `${inputId.value}-error`)
const describedBy = computed(() => [hintId.value, props.error ? errorId.value : undefined].filter(Boolean).join(' '))
const labelKey = computed(() => `lb08.fields.${props.owner}.${props.field.name}`)
const text = computed(() => (typeof props.value === 'string' ? props.value : ''))
// The values to insert, grouped by where they come from: the event first, then each earlier step.
const groups = computed(() => [...new Set(props.references.map(reference => reference.source))].map(source => ({
  source,
  label: source === 'trigger' ? t('lb08.fields.trigger.event.label') : props.sources[source] ?? source,
  items: props.references.filter(reference => reference.source === source),
})))

/** The words for one option of a list: its translation when the locale has one (channels keep their own names), otherwise the option itself. */
function optionLabel(option: string): string {
  const key = `lb08.choices.${props.field.name}.${option}`
  return te(key) ? t(key) : option
}

/** The words for a value of the event or of a step, in the visitor's language. */
function valueLabel(field: string): string {
  const key = `lb08.values.${field}`
  return te(key) ? t(key) : field
}

/** Takes the text of an input event. */
function typed(event: Event): string {
  const target = event.target
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement ? target.value : ''
}

/** Appends a value to the text, as `{{reference}}`, and picks the list back to its prompt. */
function insert(event: Event): void {
  const reference = typed(event)
  if (reference === '') return
  const separator = text.value === '' || text.value.endsWith(' ') ? '' : ' '
  emit('change', `${text.value}${separator}{{${reference}}}`)
  if (event.target instanceof HTMLSelectElement) event.target.value = ''
}

/** A row of a record, kept here while it is typed: its name may be empty or repeated for a moment, which a record cannot hold. */
interface Row {
  key: number
  name: string
  value: string
}
let nextKey = 1
/** Reads a record into rows. */
function rowsOf(value: unknown): Row[] {
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).map(([name, entry]) => ({ key: nextKey++, name, value: typeof entry === 'string' ? entry : '' }))
}
const rows = ref<Row[]>(rowsOf(props.value))
const asRecord = computed(() => Object.fromEntries(rows.value.filter(row => row.name !== '').map(row => [row.name, row.value])))

// A change that comes from outside (undo, discard) replaces the rows; one the rows made themselves does not.
watch(() => props.value, (value) => {
  if (JSON.stringify(value ?? {}) !== JSON.stringify(asRecord.value)) rows.value = rowsOf(value)
}, { deep: true })

/** Tells the step about the rows as they are now. */
function sendRows(): void {
  emit('change', asRecord.value)
}

/** Adds an empty row with a name no row has. */
function addRow(): void {
  let number = rows.value.length + 1
  while (rows.value.some(row => row.name === `field${number}`)) number += 1
  rows.value = [...rows.value, { key: nextKey++, name: `field${number}`, value: '' }]
  sendRows()
}

/** Removes the row at a position. */
function removeRow(key: number): void {
  rows.value = rows.value.filter(row => row.key !== key)
  sendRows()
}
</script>

<template>
  <div
    class="lb8-field"
    :data-field="field.name"
  >
    <template v-if="field.kind === 'entries'">
      <span
        :id="`${inputId}-label`"
        class="lb8-label"
      >{{ t(`${labelKey}.label`) }}</span>
      <div
        class="rows"
        role="group"
        :aria-labelledby="`${inputId}-label`"
        :aria-describedby="describedBy"
      >
        <div
          v-for="row in rows"
          :key="row.key"
          class="row"
        >
          <input
            v-model="row.name"
            class="lb8-control lb8-mono"
            type="text"
            maxlength="32"
            :aria-label="t('lb08.inspector.rowName')"
            @input="sendRows"
          >
          <input
            v-model="row.value"
            class="lb8-control"
            type="text"
            :maxlength="field.valueMaxLength"
            :aria-label="`${t('lb08.inspector.rowValue')}: ${row.name}`"
            @input="sendRows"
          >
          <button
            type="button"
            class="lb8-button lb8-button--quiet"
            :aria-label="t('lb08.inspector.removeRow', { name: row.name })"
            @click="removeRow(row.key)"
          >
            <LbIcon
              name="close"
              :size="16"
              tone="mono"
            />
          </button>
        </div>
        <div class="lb8-row">
          <button
            type="button"
            class="lb8-button"
            :disabled="rows.length >= field.maxEntries"
            @click="addRow"
          >
            {{ t('lb08.inspector.addRow') }}
          </button>
          <span
            v-if="rows.length >= field.maxEntries"
            class="lb8-hint"
          >{{ t('lb08.inspector.rowsFull', { max: field.maxEntries }) }}</span>
        </div>
      </div>
    </template>

    <template v-else>
      <label :for="inputId">
        {{ t(`${labelKey}.label`) }}
        <span
          v-if="!field.required"
          class="lb8-hint"
        >({{ t('lb08.inspector.optional') }})</span>
      </label>
      <select
        v-if="field.kind === 'choice'"
        :id="inputId"
        class="lb8-control"
        :value="text"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="describedBy"
        @change="emit('change', typed($event))"
      >
        <option
          v-if="!field.required || text === ''"
          value=""
        >
          {{ field.required ? '' : t('lb08.inspector.optional') }}
        </option>
        <option
          v-for="option in field.options"
          :key="option"
          :value="option"
        >
          {{ optionLabel(option) }}
        </option>
      </select>
      <textarea
        v-else-if="field.multiline"
        :id="inputId"
        class="lb8-control"
        rows="3"
        :value="text"
        :maxlength="field.maxLength"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="describedBy"
        @input="emit('change', typed($event))"
      />
      <input
        v-else
        :id="inputId"
        class="lb8-control"
        :class="{ 'lb8-mono': !field.templated }"
        type="text"
        :value="text"
        :maxlength="field.maxLength"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="describedBy"
        @input="emit('change', typed($event))"
      >
      <div
        v-if="field.kind === 'text' && field.templated && references.length > 0"
        class="insert"
      >
        <label
          :for="`${inputId}-insert`"
          class="lb-sr-only"
        >{{ t('lb08.inspector.insertValue') }}: {{ t(`${labelKey}.label`) }}</label>
        <select
          :id="`${inputId}-insert`"
          class="lb8-control insert-select"
          :aria-describedby="`${inputId}-insert-help`"
          @change="insert"
        >
          <option value="">
            {{ t('lb08.inspector.insertValue') }}
          </option>
          <optgroup
            v-for="group in groups"
            :key="group.source"
            :label="group.label"
          >
            <option
              v-for="reference in group.items"
              :key="reference.reference"
              :value="reference.reference"
            >
              {{ valueLabel(reference.field) }} ({{ reference.reference }})
            </option>
          </optgroup>
        </select>
        <span
          :id="`${inputId}-insert-help`"
          class="lb-sr-only"
        >{{ t('lb08.inspector.insertHelp') }}</span>
      </div>
    </template>

    <p
      :id="hintId"
      class="lb8-hint"
    >
      {{ t(`${labelKey}.hint`) }}
    </p>
    <p
      v-if="error"
      :id="errorId"
      class="lb8-error"
      data-testid="field-error"
    >
      <LbIcon
        name="warning"
        :size="16"
        tone="mono"
      />
      <span>{{ error }}</span>
    </p>
  </div>
</template>

<style scoped>
.rows {
  display: grid;
  gap: 6px;
  width: 100%;
}

.row {
  display: grid;
  grid-template-columns: minmax(80px, 1fr) minmax(0, 2fr) auto;
  gap: 6px;
  align-items: center;
}

.insert {
  width: 100%;
}

.insert-select {
  font-size: 12.5px;
}
</style>
