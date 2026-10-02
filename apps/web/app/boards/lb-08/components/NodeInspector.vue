<script setup lang="ts">
// <NodeInspector>: the form of the step or the connection the visitor picked, in the canvas or in the
// outline. A step's own settings are drawn by <ParamField> from the schema that checks the step, so
// there is no form written for any one connector; what is written here is only what is not a
// setting of a connector: the step's name, the choice of connector, the condition's comparison (which
// depends on the kind of value it reads) and the branch of a connection. Every change goes to the
// store, which validates the whole workflow again and says where each problem is; a problem with
// a field is shown next to that field.
import { LbIcon } from '@lb/icons'
import { OPS_BY_KIND, branchLabelsFor, connectorIds } from '@lb/contracts'
import type { BranchLabel, ComparisonOp, ConnectorId, WorkflowNode } from '@lb/contracts'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { defaultTexts } from '../graph/defaults'
import { kindOf } from '../graph/visual'
import { problemOf, reasonFor, textReason } from '../graph/field-errors'
import { fieldsFor, valueOf, withValue } from '../graph/form'
import type { FormField } from '../graph/form'
import { wordsFor } from '../graph/issues'
import { findReference, referencesAt } from '../graph/references'
import { useLb08Store } from '../store'

import ParamField from './ParamField.vue'

defineProps<{
  /** The Brief reading leaves out the technical details, such as the step's id. */
  brief: boolean
}>()

const { t, te } = useI18n()
const store = useLb08Store()
const { draft, selection, issues, canEdit } = storeToRefs(store)

const title = ref<HTMLElement>()

const node = computed(() => {
  const picked = selection.value
  return picked?.kind === 'node' ? draft.value?.nodes.find(candidate => candidate.id === picked.id) : undefined
})
const connection = computed(() => {
  const picked = selection.value
  if (picked?.kind !== 'edge' || !draft.value) return undefined
  const edge = draft.value.edges[picked.index]
  return edge ? { index: picked.index, edge } : undefined
})
const located = computed(() => (node.value ? issues.value?.byNode.get(node.value.id) ?? [] : []))
const references = computed(() => (node.value && draft.value ? referencesAt(draft.value, node.value.id) : []))
const sources = computed(() => Object.fromEntries((draft.value?.nodes ?? []).map(candidate => [candidate.id, candidate.label || candidate.id])))
const fields = computed(() => (node.value ? fieldsFor(node.value) : []))
const owner = computed(() => (node.value ? (node.value.type === 'action' ? node.value.connector : node.value.type) : ''))
const kindName = computed(() => (node.value ? t(`lb08.kinds.${kindOf(node.value)}`) : ''))
const stepName = computed(() => node.value?.label || node.value?.id || '')
const idPrefix = computed(() => `lb08-inspector-${node.value?.id ?? 'edge'}`)
const edgeBranches = computed(() => (connection.value && draft.value ? branchLabelsFor(draft.value.nodes.find(candidate => candidate.id === connection.value?.edge.from)?.type ?? '') : []))
const edgeSteps = computed(() => {
  const edge = connection.value?.edge
  const name = (id: string | undefined) => draft.value?.nodes.find(candidate => candidate.id === id)?.label || id || ''
  return { from: name(edge?.from), to: name(edge?.to) }
})
const edgeLocated = computed(() => (connection.value ? issues.value?.byEdge.get(connection.value.index) ?? [] : []))

/** The words for a field's name in a message. */
function labelOf(ownerName: string, name: string): string {
  const key = `lb08.fields.${ownerName}.${name}.label`
  return te(key) ? t(key) : name
}

/** The words for a value of the event or of a step. */
function valueLabel(field: string): string {
  const key = `lb08.values.${field}`
  return te(key) ? t(key) : field
}

/** Writes the words about a problem for a field, or nothing when the field has none. */
function errorFor(field: FormField): string | undefined {
  const found = problemOf(located.value, field.name)
  if (!found || !node.value || !draft.value) return undefined
  const code = found.issue.code
  if (code === 'invalid_param' || code === 'invalid_value') {
    const reason = reasonFor(field, valueOf(node.value, field.name))
    if (reason === 'required') return t('lb08.inspector.required')
    if (reason === 'tooLong') return t('lb08.inspector.tooLong', { max: field.kind === 'text' ? field.maxLength : 0 })
    return t('lb08.inspector.format', { hint: t(`lb08.fields.${owner.value}.${field.name}.hint`) })
  }
  const words = wordsFor(draft.value, found, labelOf)
  return t(words.key, words.params)
}

/** Writes the words about a problem with the step's name, or nothing. */
const labelError = computed(() => {
  const found = problemOf(located.value, 'label')
  if (!found || !node.value) return undefined
  return textReason(node.value.label, 60) === 'required' ? t('lb08.inspector.required') : t('lb08.inspector.tooLong', { max: 60 })
})

/** The problems with the step that no field of the form shows: the ones about the step as a whole. */
const generalProblems = computed(() => {
  const drawn = [...fields.value.map(field => field.name), 'label', 'field', 'op', 'value']
  return located.value.filter(item => !drawn.some(name => problemOf([item], name)))
})

/** Writes a general problem as words. */
function problemWords(item: (typeof located.value)[number]): string {
  if (!draft.value) return ''
  const words = wordsFor(draft.value, item, labelOf)
  return t(words.key, words.params)
}

/** Changes one setting of the step. */
function change(field: FormField, value: unknown): void {
  if (node.value) store.updateStep(withValue(node.value, field, value))
}

/** Renames the step. */
function rename(label: string): void {
  if (node.value) store.updateStep({ ...node.value, label } as WorkflowNode)
}

/** Takes the text of an input event. */
function typed(event: Event): string {
  const target = event.target
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement ? target.value : ''
}

/** Swaps an action's connector for another one. */
function switchConnector(event: Event): void {
  const next = typed(event) as ConnectorId
  if (node.value?.type === 'action' && connectorIds.includes(next)) store.changeConnector(node.value.id, next, defaultTexts(t, next))
}

// ---- A condition ----

const conditionNode = computed(() => (node.value?.type === 'condition' ? node.value : undefined))
const referenceOfCondition = computed(() => (conditionNode.value ? findReference(references.value, conditionNode.value.field) : undefined))
// The kind of value the condition reads, as the validator sees it: an email is compared as text.
const conditionKind = computed<'number' | 'boolean' | 'text'>(() => {
  const kind = referenceOfCondition.value?.kind
  return kind === 'number' || kind === 'boolean' ? kind : 'text'
})
const allowedOps = computed<readonly ComparisonOp[]>(() => OPS_BY_KIND[conditionKind.value])

/** The value a comparison starts with for a kind of value. */
function startingValue(kind: 'number' | 'boolean' | 'text'): number | boolean | string {
  return kind === 'number' ? 0 : kind === 'boolean' ? true : ''
}

/** Changes what a condition reads, and picks a comparison and a value that suit it. */
function pickField(event: Event): void {
  const node_ = conditionNode.value
  if (!node_) return
  const reference = typed(event)
  const kind = findReference(references.value, reference)?.kind
  const nextKind = kind === 'number' || kind === 'boolean' ? kind : 'text'
  store.updateStep({ ...node_, field: reference, op: 'eq', value: startingValue(nextKind) })
}

/** Changes a condition's comparison. */
function pickOp(event: Event): void {
  const node_ = conditionNode.value
  if (node_) store.updateStep({ ...node_, op: typed(event) as ComparisonOp })
}

/** Changes the value a condition compares with, as the kind of value needs. */
function pickValue(event: Event): void {
  const node_ = conditionNode.value
  if (!node_) return
  const text = typed(event)
  if (conditionKind.value === 'number') store.updateStep({ ...node_, value: text.trim() === '' || !Number.isFinite(Number(text)) ? 0 : Number(text) })
  else if (conditionKind.value === 'boolean') store.updateStep({ ...node_, value: text === 'true' })
  else store.updateStep({ ...node_, value: text })
}

const conditionFieldKnown = computed(() => conditionNode.value !== undefined && referenceOfCondition.value !== undefined)
const conditionFieldProblem = computed(() => problemOf(located.value, 'field'))
const conditionGroups = computed(() => [...new Set(references.value.map(reference => reference.source))].map(source => ({
  source,
  label: source === 'trigger' ? t('lb08.fields.trigger.event.label') : sources.value[source] ?? source,
  items: references.value.filter(reference => reference.source === source),
})))

/** The words for a comparison. */
function opLabel(op: string): string {
  return te(`lb08.choices.op.${op}`) ? t(`lb08.choices.op.${op}`) : op
}

// ---- A connection ----

/** Changes the branch of the picked connection. */
function pickBranch(event: Event): void {
  const picked = connection.value
  if (!picked) return
  const value = typed(event)
  store.relabel(picked.index, value === '' ? undefined : value as BranchLabel)
}

/** Removes the picked step. */
function removeStep(): void {
  if (node.value) store.removeStep(node.value.id)
}

/** Removes the picked connection. */
function removeConnection(): void {
  if (connection.value) store.disconnect(connection.value.index)
}

/** Moves focus to the inspector's heading, so a keyboard user who chose a step lands on its form. */
function focusTitle(): void {
  title.value?.focus()
}

defineExpose({ focusTitle })
</script>

<template>
  <section
    class="lb8-panel inspector"
    :aria-label="t('lb08.inspector.title')"
    data-testid="inspector"
  >
    <h3
      ref="title"
      tabindex="-1"
      class="heading"
    >
      <template v-if="node">
        {{ t('lb08.inspector.stepTitle', { step: stepName }) }}
      </template>
      <template v-else-if="connection">
        {{ t('lb08.inspector.edgeTitle', edgeSteps) }}
      </template>
      <template v-else>
        {{ t('lb08.inspector.title') }}
      </template>
    </h3>

    <p
      v-if="!node && !connection"
      class="lb8-hint"
    >
      {{ t('lb08.inspector.none') }}
    </p>

    <fieldset
      v-else-if="node"
      class="form"
      :disabled="!canEdit"
    >
      <legend class="lb-sr-only">
        {{ t('lb08.inspector.stepTitle', { step: stepName }) }}
      </legend>
      <p class="lb8-row">
        <span class="lb8-chip">{{ kindName }}</span>
        <span
          v-if="!brief"
          class="lb8-hint lb8-mono"
        >{{ t('lb08.inspector.id', { id: node.id }) }}</span>
      </p>
      <p class="lb8-hint">
        {{ t(`lb08.kindHints.${kindOf(node)}`) }}
      </p>

      <div class="lb8-field">
        <label :for="`${idPrefix}-label`">{{ t('lb08.inspector.label') }}</label>
        <input
          :id="`${idPrefix}-label`"
          class="lb8-control"
          type="text"
          :value="node.label"
          maxlength="60"
          :aria-invalid="labelError ? 'true' : undefined"
          :aria-describedby="`${idPrefix}-label-hint`"
          @input="rename(typed($event))"
        >
        <p
          :id="`${idPrefix}-label-hint`"
          class="lb8-hint"
        >
          {{ t('lb08.inspector.labelHint') }}
        </p>
        <p
          v-if="labelError"
          class="lb8-error"
        >
          <LbIcon
            name="warning"
            :size="16"
            tone="mono"
          />
          <span>{{ labelError }}</span>
        </p>
      </div>

      <div
        v-if="node.type === 'action'"
        class="lb8-field"
      >
        <label :for="`${idPrefix}-connector`">{{ t('lb08.inspector.connector') }}</label>
        <select
          :id="`${idPrefix}-connector`"
          class="lb8-control"
          :value="node.connector"
          @change="switchConnector"
        >
          <option
            v-for="connector in connectorIds"
            :key="connector"
            :value="connector"
          >
            {{ t(`lb08.connectors.${connector}`) }}
          </option>
        </select>
      </div>

      <template v-if="conditionNode">
        <p class="lb8-hint">
          {{ t('lb08.inspector.conditionHelp') }}
        </p>
        <div class="lb8-field">
          <label :for="`${idPrefix}-field`">{{ t('lb08.fields.condition.field.label') }}</label>
          <select
            :id="`${idPrefix}-field`"
            class="lb8-control"
            :value="conditionNode.field"
            :aria-invalid="problemOf(located, 'field') ? 'true' : undefined"
            @change="pickField"
          >
            <option
              v-if="!conditionFieldKnown"
              :value="conditionNode.field"
            >
              {{ conditionNode.field }}
            </option>
            <optgroup
              v-for="group in conditionGroups"
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
          <p class="lb8-hint">
            {{ t('lb08.fields.condition.field.hint') }}
          </p>
          <p
            v-if="conditionFieldProblem"
            class="lb8-error"
          >
            <LbIcon
              name="warning"
              :size="16"
              tone="mono"
            />
            <span>{{ problemWords(conditionFieldProblem) }}</span>
          </p>
        </div>
        <div class="lb8-field">
          <label :for="`${idPrefix}-op`">{{ t('lb08.fields.condition.op.label') }}</label>
          <select
            :id="`${idPrefix}-op`"
            class="lb8-control"
            :value="conditionNode.op"
            @change="pickOp"
          >
            <option
              v-for="op in allowedOps"
              :key="op"
              :value="op"
            >
              {{ opLabel(op) }}
            </option>
            <option
              v-if="!allowedOps.includes(conditionNode.op)"
              :value="conditionNode.op"
            >
              {{ opLabel(conditionNode.op) }}
            </option>
          </select>
          <p class="lb8-hint">
            {{ t('lb08.fields.condition.op.hint') }}
          </p>
        </div>
        <div class="lb8-field">
          <label :for="`${idPrefix}-value`">{{ t('lb08.fields.condition.value.label') }}</label>
          <select
            v-if="conditionKind === 'boolean'"
            :id="`${idPrefix}-value`"
            class="lb8-control"
            :value="String(conditionNode.value)"
            @change="pickValue"
          >
            <option value="true">
              {{ t('lb08.inspector.boolYes') }}
            </option>
            <option value="false">
              {{ t('lb08.inspector.boolNo') }}
            </option>
          </select>
          <input
            v-else-if="conditionKind === 'number'"
            :id="`${idPrefix}-value`"
            class="lb8-control"
            type="number"
            step="any"
            :value="typeof conditionNode.value === 'number' ? conditionNode.value : 0"
            @input="pickValue"
          >
          <input
            v-else
            :id="`${idPrefix}-value`"
            class="lb8-control"
            type="text"
            maxlength="60"
            :value="typeof conditionNode.value === 'string' ? conditionNode.value : ''"
            @input="pickValue"
          >
          <p class="lb8-hint">
            {{ t('lb08.fields.condition.value.hint') }}
          </p>
        </div>
      </template>

      <p
        v-if="node.type === 'trigger'"
        class="lb8-hint"
      >
        {{ t('lb08.inspector.triggerHelp') }}
      </p>

      <ParamField
        v-for="field in fields"
        :key="`${owner}-${field.name}`"
        :field="field"
        :owner="owner"
        :value="valueOf(node, field.name)"
        :references="references"
        :sources="sources"
        :error="errorFor(field)"
        :id-prefix="idPrefix"
        @change="change(field, $event)"
      />

      <div
        v-if="generalProblems.length > 0"
        class="problems"
        role="group"
        :aria-label="t('lb08.inspector.stepErrors')"
      >
        <p
          v-for="(item, index) in generalProblems"
          :key="index"
          class="lb8-error"
        >
          <LbIcon
            name="warning"
            :size="16"
            tone="mono"
          />
          <span>{{ problemWords(item) }}</span>
        </p>
      </div>

      <div class="lb8-row">
        <button
          v-if="node.type !== 'trigger'"
          type="button"
          class="lb8-button"
          data-testid="inspector-remove"
          @click="removeStep"
        >
          {{ t('lb08.inspector.remove') }}
        </button>
        <button
          type="button"
          class="lb8-button lb8-button--quiet"
          @click="store.select(undefined)"
        >
          {{ t('lb08.inspector.close') }}
        </button>
      </div>
    </fieldset>

    <fieldset
      v-else-if="connection"
      class="form"
      :disabled="!canEdit"
    >
      <legend class="lb-sr-only">
        {{ t('lb08.inspector.edgeTitle', edgeSteps) }}
      </legend>
      <div
        v-if="edgeBranches.length > 0 || connection.edge.branch"
        class="lb8-field"
      >
        <label :for="`${idPrefix}-branch`">{{ t('lb08.outline.branch') }}</label>
        <select
          :id="`${idPrefix}-branch`"
          class="lb8-control"
          :value="connection.edge.branch ?? ''"
          @change="pickBranch"
        >
          <option value="">
            {{ t('lb08.outline.noBranch') }}
          </option>
          <option
            v-for="branch in edgeBranches"
            :key="branch"
            :value="branch"
          >
            {{ t(`lb08.branches.${branch}`) }}
          </option>
          <option
            v-if="connection.edge.branch && !edgeBranches.includes(connection.edge.branch)"
            :value="connection.edge.branch"
          >
            {{ t(`lb08.branches.${connection.edge.branch}`) }}
          </option>
        </select>
      </div>
      <p
        v-for="(item, index) in edgeLocated"
        :key="index"
        class="lb8-error"
      >
        <LbIcon
          name="warning"
          :size="16"
          tone="mono"
        />
        <span>{{ problemWords(item) }}</span>
      </p>
      <div class="lb8-row">
        <button
          type="button"
          class="lb8-button"
          data-testid="inspector-remove"
          @click="removeConnection"
        >
          {{ t('lb08.inspector.removeEdge') }}
        </button>
        <button
          type="button"
          class="lb8-button lb8-button--quiet"
          @click="store.select(undefined)"
        >
          {{ t('lb08.inspector.close') }}
        </button>
      </div>
    </fieldset>
  </section>
</template>

<style scoped>
.inspector {
  align-content: start;
}

.heading {
  font-family: var(--lb-font-sans);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: normal;
  text-transform: none;
  color: var(--lb-ink);
}

.heading:focus-visible {
  outline: 2px solid var(--lb-signal);
  outline-offset: 2px;
}

.form {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 0;
  margin: 0;
  border: 0;
}

.problems {
  display: grid;
  gap: 4px;
}
</style>
