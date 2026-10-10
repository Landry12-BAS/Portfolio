<script setup lang="ts">
// <OrderForm>: the test order a run starts with. It has one input for each value the workflow's
// trigger event carries, drawn from the event's field list in @lb/contracts, so a different event
// gives a different form. The values start as the catalogue's examples. A value is checked by the
// same schema the service checks it with, and a problem is written beside the field it belongs to,
// shown once the visitor has changed that field or asked for the run, so a form never opens
// already scolding.
import { storeToRefs } from 'pinia'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { formatCount } from '~/board-kit/format'

import type { OrderField } from '../graph/order'
import { useLb08Store } from '../store'

const { t, te, locale } = useI18n()
const store = useLb08Store()
const { orderFieldList, orderEntries, orderIssues, orderShown, triggerEvent, canEdit } = storeToRefs(store)

// The fields the visitor has changed, which are the ones allowed to show a problem before a run is asked for.
const touched = ref<ReadonlySet<string>>(new Set())

/** The words for a field's name. */
function labelOf(field: OrderField): string {
  const key = `lb08.values.${field.name}`
  return te(key) ? t(key) : field.name
}

/** What the form holds for a text field. */
function textOf(field: OrderField): string {
  const entry = orderEntries.value[field.name]
  return typeof entry === 'string' ? entry : ''
}

/** Tells whether a yes-or-no field is ticked. */
function ticked(field: OrderField): boolean {
  return orderEntries.value[field.name] === true
}

/** The words about a field's problem, once it may be shown. */
function problemOf(field: OrderField): string | undefined {
  const problem = orderIssues.value.get(field.name)
  if (problem === undefined || !(orderShown.value || touched.value.has(field.name))) return undefined
  return t(`lb08.run.orderProblems.${problem}`)
}

/** What a number field accepts, in words. */
function rangeOf(field: OrderField): string | undefined {
  if (field.kind !== 'number' || field.min === undefined) return undefined
  if (field.max === undefined) return t('lb08.run.orderMin', { min: formatCount(field.min, locale.value) })
  return t('lb08.run.orderRange', { min: formatCount(field.min, locale.value), max: formatCount(field.max, locale.value) })
}

/** The ids of the texts that describe a field: its range, and its problem when it has one. */
function describedBy(field: OrderField): string | undefined {
  const ids = [
    rangeOf(field) ? `lb08-order-${field.name}-hint` : undefined,
    problemOf(field) ? `lb08-order-${field.name}-error` : undefined,
  ].filter((id): id is string => id !== undefined)
  return ids.length > 0 ? ids.join(' ') : undefined
}

/** Remembers that a field has been changed. */
function touch(field: OrderField): void {
  touched.value = new Set([...touched.value, field.name])
}

/** Takes what was typed into a text field. */
function type(field: OrderField, event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  touch(field)
  store.setOrder(field.name, target.value)
}

/** Takes the tick of a yes-or-no field. */
function tick(field: OrderField, event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  touch(field)
  store.setOrder(field.name, target.checked)
}

/** Puts the examples back. */
function again(): void {
  touched.value = new Set()
  orderShown.value = false
  store.resetOrder()
}
</script>

<template>
  <fieldset
    class="order"
    data-testid="order"
  >
    <legend>{{ t('lb08.run.orderTitle') }}</legend>
    <p
      v-if="triggerEvent"
      class="lb8-hint"
    >
      {{ t('lb08.run.orderEvent', { event: t(`lb08.events.${triggerEvent}`) }) }}
    </p>
    <div class="grid">
      <div
        v-for="field in orderFieldList"
        :key="field.name"
        class="lb8-field"
        :class="{ tick: field.kind === 'boolean' }"
      >
        <template v-if="field.kind === 'boolean'">
          <label :for="`lb08-order-${field.name}`">
            <input
              :id="`lb08-order-${field.name}`"
              type="checkbox"
              :checked="ticked(field)"
              :disabled="!canEdit"
              @change="tick(field, $event)"
            >
            {{ labelOf(field) }}
          </label>
        </template>
        <template v-else>
          <label :for="`lb08-order-${field.name}`">{{ labelOf(field) }}</label>
          <input
            :id="`lb08-order-${field.name}`"
            class="lb8-control"
            type="text"
            :inputmode="field.kind === 'number' ? 'decimal' : field.kind === 'email' ? 'email' : 'text'"
            :value="textOf(field)"
            :placeholder="field.example"
            :maxlength="field.kind === 'number' ? 16 : field.max"
            :disabled="!canEdit"
            :aria-invalid="problemOf(field) !== undefined"
            :aria-describedby="describedBy(field)"
            autocomplete="off"
            spellcheck="false"
            @input="type(field, $event)"
          >
          <span
            v-if="rangeOf(field)"
            :id="`lb08-order-${field.name}-hint`"
            class="lb8-hint"
          >{{ rangeOf(field) }}</span>
        </template>
        <span
          v-if="problemOf(field)"
          :id="`lb08-order-${field.name}-error`"
          class="lb8-error"
          data-testid="order-problem"
        >{{ problemOf(field) }}</span>
      </div>
    </div>
    <button
      type="button"
      class="lb8-button lb8-button--quiet again"
      :disabled="!canEdit"
      @click="again"
    >
      {{ t('lb08.run.resetOrder') }}
    </button>
  </fieldset>
</template>

<style scoped>
.order {
  display: grid;
  gap: 10px;
  min-width: 0;
  padding: 10px 12px 12px;
  margin: 0;
  border: 1px solid var(--lb-rule);
}

.order > legend {
  padding: 0 6px;
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 10px 14px;
}

.tick {
  align-self: end;
}

.tick label {
  display: inline-flex;
  gap: 8px;
  align-items: center;
}

.again {
  justify-self: start;
}
</style>
