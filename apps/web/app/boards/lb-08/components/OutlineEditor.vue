<script setup lang="ts">
// <OutlineEditor>: the workflow as a list of steps, for the keyboard and for screen readers. It
// does everything the canvas does and edits the same state: pick a step to edit it, remove it,
// connect it to another step on a branch, change a connection's branch, cut it. Each step is listed
// in the order a run reaches it, with where it comes from and where it goes, and the problems the
// validator found with it are written under it. Nothing here needs a pointer.
import { LbIcon } from '@lb/icons'
import { branchLabelsFor } from '@lb/contracts'
import type { BranchLabel, WorkflowNode } from '@lb/contracts'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { wordsFor } from '../graph/issues'
import type { LocatedIssue } from '../graph/issues'
import { outlineOf } from '../graph/outline'
import { iconFor, kindOf } from '../graph/visual'
import { useLb08Store } from '../store'

const emit = defineEmits<{
  /** The visitor picked a step or a connection to edit: the editor moves focus to its form. */
  pick: []
  /** Something was done that is worth saying aloud. */
  said: [text: string]
}>()

const { t, te } = useI18n()
const store = useLb08Store()
const { draft, selection, issues, canEdit } = storeToRefs(store)

const items = computed(() => (draft.value ? outlineOf(draft.value) : []))
// What each step's "connect to" form has chosen so far.
const targets = ref<Record<string, string>>({})
const branches = ref<Record<string, string>>({})

/** The words for a field's name in a message. */
function labelOf(owner: string, name: string): string {
  const key = `lb08.fields.${owner}.${name}.label`
  return te(key) ? t(key) : name
}

/** A step's name for a sentence. */
function nameOf(node: WorkflowNode | undefined): string {
  return node?.label || node?.id || t('lb08.outline.missingTarget')
}

/** Writes a problem as words. */
function words(item: LocatedIssue): string {
  if (!draft.value) return ''
  const found = wordsFor(draft.value, item, labelOf)
  return t(found.key, found.params)
}

/** Tells whether a step is the one being edited. */
function isPicked(node: WorkflowNode): boolean {
  return selection.value?.kind === 'node' && selection.value.id === node.id
}

/** Tells whether a connection is the one being edited. */
function isPickedEdge(index: number): boolean {
  return selection.value?.kind === 'edge' && selection.value.index === index
}

/** Picks a step for the inspector. */
function edit(node: WorkflowNode): void {
  store.select({ kind: 'node', id: node.id })
  emit('pick')
}

/** Picks a connection for the inspector. */
function editEdge(index: number): void {
  store.select({ kind: 'edge', index })
  emit('pick')
}

/** Removes a step. */
function remove(node: WorkflowNode): void {
  store.removeStep(node.id)
  emit('said', t('lb08.editor.announce.removed', { step: nameOf(node) }))
}

/** The branches a step's connections may take. */
function branchesOf(node: WorkflowNode): readonly BranchLabel[] {
  return branchLabelsFor(node.type)
}

/** Connects a step to the one its form chose. */
function connect(node: WorkflowNode): void {
  const target = targets.value[node.id]
  if (!target || !draft.value) return
  const chosen = branches.value[node.id]
  store.connect(node.id, target, chosen ? chosen as BranchLabel : undefined)
  const to = draft.value.nodes.find(candidate => candidate.id === target)
  emit('said', t('lb08.editor.announce.connected', { from: nameOf(node), to: nameOf(to) }))
  targets.value = { ...targets.value, [node.id]: '' }
}

/** Cuts a connection. */
function cut(index: number, from: WorkflowNode, to: WorkflowNode | undefined): void {
  store.disconnect(index)
  emit('said', t('lb08.editor.announce.disconnected', { from: nameOf(from), to: nameOf(to) }))
}

/** Changes the branch of a connection. */
function relabel(index: number, event: Event): void {
  const target = event.target
  const value = target instanceof HTMLSelectElement ? target.value : ''
  store.relabel(index, value === '' ? undefined : value as BranchLabel)
}

/** Records which step the connect form of a step has chosen. */
function chooseTarget(node: WorkflowNode, event: Event): void {
  const target = event.target
  targets.value = { ...targets.value, [node.id]: target instanceof HTMLSelectElement ? target.value : '' }
}

/** Records which branch the connect form of a step has chosen. */
function chooseBranch(node: WorkflowNode, event: Event): void {
  const target = event.target
  branches.value = { ...branches.value, [node.id]: target instanceof HTMLSelectElement ? target.value : '' }
}
</script>

<template>
  <ol
    class="outline"
    :aria-label="t('lb08.editor.outlineLabel')"
    data-testid="outline"
  >
    <li
      v-for="item in items"
      :id="`step-${item.node.id}`"
      :key="item.node.id"
      class="step"
      :class="{ picked: isPicked(item.node) }"
      data-testid="outline-step"
      :data-step="item.node.id"
    >
      <div class="head">
        <span class="number lb8-mono">{{ item.number }}</span>
        <LbIcon
          :name="iconFor(item.node)"
          :size="18"
          tone="mono"
        />
        <span class="lb8-chip">{{ t(`lb08.kinds.${kindOf(item.node)}`) }}</span>
        <strong class="name">{{ nameOf(item.node) }}</strong>
        <span class="actions">
          <button
            type="button"
            class="lb8-button"
            :aria-pressed="isPicked(item.node)"
            :aria-label="t('lb08.outline.editLabel', { step: nameOf(item.node) })"
            data-testid="outline-edit"
            @click="edit(item.node)"
          >
            {{ t('lb08.outline.edit') }}
          </button>
          <button
            v-if="item.node.type !== 'trigger'"
            type="button"
            class="lb8-button"
            :disabled="!canEdit"
            :aria-label="t('lb08.outline.removeLabel', { step: nameOf(item.node) })"
            data-testid="outline-remove"
            @click="remove(item.node)"
          >
            {{ t('lb08.outline.remove') }}
          </button>
        </span>
      </div>

      <p class="line">
        <span class="lb-label">{{ t('lb08.outline.startsAfter') }}</span>
        <template v-if="item.incoming.length === 0">
          {{ t('lb08.outline.nothingBefore') }}
        </template>
        <template v-else>
          {{ item.incoming.map(connection => nameOf(connection.source) + (connection.edge.branch ? ` (${t(`lb08.branches.${connection.edge.branch}`)})` : '')).join(', ') }}
        </template>
      </p>

      <div class="line">
        <span class="lb-label">{{ t('lb08.outline.goesTo') }}</span>
        <template v-if="item.outgoing.length === 0">
          {{ t('lb08.outline.nothingAfter') }}
        </template>
        <ul
          v-else
          class="connections"
        >
          <li
            v-for="connection in item.outgoing"
            :key="connection.index"
            class="connection"
            :class="{ picked: isPickedEdge(connection.index) }"
            data-testid="outline-connection"
          >
            <span
              class="to"
              role="group"
              :aria-label="t('lb08.outline.connectionLabel', { from: nameOf(item.node), to: nameOf(connection.target) })"
            >
              <span aria-hidden="true">→</span>
              {{ nameOf(connection.target) }}
            </span>
            <template v-if="branchesOf(item.node).length > 0 || connection.edge.branch">
              <label
                class="lb-sr-only"
                :for="`branch-${connection.index}`"
              >{{ t('lb08.outline.changeBranch', { to: nameOf(connection.target) }) }}</label>
              <select
                :id="`branch-${connection.index}`"
                class="lb8-control branch"
                :value="connection.edge.branch ?? ''"
                :disabled="!canEdit"
                @change="relabel(connection.index, $event)"
              >
                <option value="">
                  {{ t('lb08.outline.noBranch') }}
                </option>
                <option
                  v-for="branch in branchesOf(item.node)"
                  :key="branch"
                  :value="branch"
                >
                  {{ t(`lb08.branches.${branch}`) }}
                </option>
                <option
                  v-if="connection.edge.branch && !branchesOf(item.node).includes(connection.edge.branch)"
                  :value="connection.edge.branch"
                >
                  {{ t(`lb08.branches.${connection.edge.branch}`) }}
                </option>
              </select>
            </template>
            <button
              type="button"
              class="lb8-button lb8-button--quiet"
              :aria-pressed="isPickedEdge(connection.index)"
              @click="editEdge(connection.index)"
            >
              {{ t('lb08.outline.edit') }}
              <span class="lb-sr-only">{{ t('lb08.outline.connectionLabel', { from: nameOf(item.node), to: nameOf(connection.target) }) }}</span>
            </button>
            <button
              type="button"
              class="lb8-button lb8-button--quiet"
              :disabled="!canEdit"
              :aria-label="t('lb08.outline.cutLabel', { from: nameOf(item.node), to: nameOf(connection.target) })"
              data-testid="outline-cut"
              @click="cut(connection.index, item.node, connection.target)"
            >
              {{ t('lb08.outline.cut') }}
            </button>
            <ul
              v-if="issues?.byEdge.get(connection.index)?.length"
              class="messages"
            >
              <li
                v-for="(located, position) in issues?.byEdge.get(connection.index)"
                :key="position"
                class="lb8-error"
                data-testid="edge-problem"
              >
                <LbIcon
                  name="warning"
                  :size="16"
                  tone="mono"
                />
                <span>{{ words(located) }}</span>
              </li>
            </ul>
          </li>
        </ul>
      </div>

      <form
        class="connect"
        @submit.prevent="connect(item.node)"
      >
        <label :for="`connect-${item.node.id}`">{{ t('lb08.outline.connectTo', { step: nameOf(item.node) }) }}</label>
        <select
          :id="`connect-${item.node.id}`"
          class="lb8-control target"
          :value="targets[item.node.id] ?? ''"
          :disabled="!canEdit"
          @change="chooseTarget(item.node, $event)"
        >
          <option value="">
            {{ t('lb08.outline.connectChoose') }}
          </option>
          <option
            v-for="other in items.filter(candidate => candidate.node.id !== item.node.id)"
            :key="other.node.id"
            :value="other.node.id"
          >
            {{ other.number }}. {{ nameOf(other.node) }}
          </option>
        </select>
        <template v-if="branchesOf(item.node).length > 0">
          <label
            class="lb-sr-only"
            :for="`connect-branch-${item.node.id}`"
          >{{ t('lb08.outline.connectBranch') }}</label>
          <select
            :id="`connect-branch-${item.node.id}`"
            class="lb8-control branch"
            :value="branches[item.node.id] ?? ''"
            :disabled="!canEdit"
            @change="chooseBranch(item.node, $event)"
          >
            <option value="">
              {{ t('lb08.outline.noBranch') }}
            </option>
            <option
              v-for="branch in branchesOf(item.node)"
              :key="branch"
              :value="branch"
            >
              {{ t(`lb08.branches.${branch}`) }}
            </option>
          </select>
        </template>
        <button
          type="submit"
          class="lb8-button"
          :disabled="!canEdit || !targets[item.node.id]"
          data-testid="outline-connect"
        >
          {{ t('lb08.outline.connect') }}
        </button>
      </form>

      <ul
        v-if="issues?.byNode.get(item.node.id)?.length"
        class="messages"
      >
        <li
          v-for="(located, position) in issues?.byNode.get(item.node.id)"
          :key="position"
          class="lb8-error"
          data-testid="step-problem"
        >
          <LbIcon
            name="warning"
            :size="16"
            tone="mono"
          />
          <span>{{ words(located) }}</span>
        </li>
      </ul>
    </li>
  </ol>
</template>

<style scoped>
.outline {
  display: grid;
  gap: 8px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.step {
  display: grid;
  gap: 8px;
  padding: 10px 12px;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-rule);
}

.step.picked {
  background: var(--lb-board-tint);
  border-color: var(--lb-board);
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.number {
  min-width: 22px;
  color: var(--lb-graphite);
}

.name {
  flex: 1 1 140px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.actions {
  display: inline-flex;
  gap: 6px;
}

.line {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
  font-size: 13.5px;
}

.connections {
  display: grid;
  flex: 1 1 100%;
  gap: 6px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.connection {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 8px;
  align-items: center;
  padding: 4px 6px;
  border-left: 3px solid var(--lb-rule);
}

.connection.picked {
  border-left-color: var(--lb-board);
}

.to {
  flex: 1 1 140px;
  font-weight: 600;
}

.branch {
  width: auto;
  min-width: 110px;
  padding-block: 4px;
}

.target {
  width: auto;
  min-width: 160px;
  max-width: 100%;
  padding-block: 4px;
}

.connect {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 8px;
  align-items: center;
  font-size: 13px;
}

.connect > label:first-child {
  font-weight: 700;
}

.messages {
  display: grid;
  flex: 1 1 100%;
  gap: 4px;
  padding: 0;
  margin: 0;
  list-style: none;
}
</style>
