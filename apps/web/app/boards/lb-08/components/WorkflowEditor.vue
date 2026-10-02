<script setup lang="ts">
// <WorkflowEditor>: where the workflow on the board is edited. Two views of one state: the canvas
// (Vue Flow, loaded only when it is wanted) for those who point, and the outline for the keyboard and
// for screen readers, with the same operations. Beside them the inspector shows the form of the
// step or the connection picked, and below them the validator's problems are listed. Every edit is
// checked at once by the shared schema and validator, a workflow with problems can be neither saved
// nor run, and saving makes the draft the next version.
import { LbIcon } from '@lb/icons'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onMounted, ref, shallowRef, watch } from 'vue'
import type { Component } from 'vue'
import { useI18n } from 'vue-i18n'

import { defaultTexts } from '../graph/defaults'
import { STEP_KINDS, isStepKind } from '../graph/edit'
import type { StepKind } from '../graph/edit'
import { useLb08Store } from '../store'

import IssueList from './IssueList.vue'
import NodeInspector from './NodeInspector.vue'
import OutlineEditor from './OutlineEditor.vue'

defineProps<{
  /** The Brief reading leaves out the validator's codes and the step ids. */
  brief: boolean
}>()

const { t } = useI18n()
const store = useLb08Store()
const { workflow, draft, dirty, valid, selection, saving, saveProblem, canEdit, runMode, history } = storeToRefs(store)

/** The two ways to edit the one workflow. */
type View = 'canvas' | 'outline'

/** A wide screen with a pointer starts on the canvas; anything else starts on the outline. */
function startingView(): View {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'outline'
  return window.matchMedia('(min-width: 900px) and (pointer: fine)').matches ? 'canvas' : 'outline'
}

const view = ref<View>(startingView())
const inspector = ref<InstanceType<typeof NodeInspector>>()
const kind = ref<StepKind>('slack_alert')
const said = ref('')
const saidKey = ref(0)
// The canvas is a separate piece of code: it is fetched when it is first wanted and not before.
const Canvas = shallowRef<Component>()
const canvasStatus = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')

const viewOptions = computed(() => [
  { value: 'canvas' as const, label: t('lb08.editor.canvas') },
  { value: 'outline' as const, label: t('lb08.editor.outline') },
])
const pickedStep = computed(() => {
  const picked = selection.value
  return picked?.kind === 'node' ? draft.value?.nodes.find(node => node.id === picked.id) : undefined
})
const nextVersion = computed(() => (workflow.value?.version ?? 0) + 1)
const canSave = computed(() => dirty.value && valid.value && !saving.value && canEdit.value)
const saveHint = computed(() => {
  if (!dirty.value) return t('lb08.editor.nothingToSave')
  if (!valid.value) return t('lb08.editor.saveBlocked')
  return undefined
})
const replaying = computed(() => runMode.value === 'replay')
const kindOptions = computed(() => STEP_KINDS.map(option => ({ value: option, label: t(`lb08.kinds.${option}`) })))

/** Says something aloud, in a live region the visitor cannot see. */
function say(text: string): void {
  said.value = text
  saidKey.value += 1
}

/** Fetches the canvas the first time it is wanted. */
async function loadCanvas(): Promise<void> {
  if (canvasStatus.value !== 'idle') return
  canvasStatus.value = 'loading'
  try {
    Canvas.value = (await import('./GraphCanvas.vue')).default
    canvasStatus.value = 'ready'
  }
  catch {
    canvasStatus.value = 'failed'
  }
}

watch(view, (next) => {
  if (next === 'canvas') void loadCanvas()
}, { immediate: false })

onMounted(() => {
  if (view.value === 'canvas') void loadCanvas()
})

/** Moves focus to the inspector's heading, once it shows the step or the connection that was picked. */
async function focusInspector(): Promise<void> {
  await nextTick()
  inspector.value?.focusTitle()
}

/** Takes the kind of step an input event chose. */
function pickKind(event: Event): void {
  const target = event.target
  const value = target instanceof HTMLSelectElement ? target.value : ''
  if (isStepKind(value)) kind.value = value
}

/** Adds a step of the chosen kind after the picked step, and moves to its form. */
async function addStep(): Promise<void> {
  const before = draft.value?.nodes.length ?? 0
  store.addStep(kind.value, defaultTexts(t, kind.value), pickedStep.value?.id)
  if ((draft.value?.nodes.length ?? 0) === before) return
  const picked = selection.value
  const added = picked?.kind === 'node' ? draft.value?.nodes.find(node => node.id === picked.id) : undefined
  say(t('lb08.editor.announce.added', { step: added?.label ?? '' }))
  await focusInspector()
}

/** Saves the draft as the next version. */
async function save(): Promise<void> {
  if (await store.save()) say(t('lb08.editor.announce.saved', { version: workflow.value?.version ?? 0 }))
}

/** Takes back the last edit. */
function undo(): void {
  store.undo()
  say(t('lb08.editor.announce.undone'))
}

/** Throws the edits away. */
function discard(): void {
  store.discard()
  say(t('lb08.editor.announce.discarded'))
}

/** Renames the workflow. */
function rename(event: Event): void {
  const target = event.target
  if (target instanceof HTMLInputElement) store.rename(target.value)
}

defineExpose({ view })
</script>

<template>
  <section
    v-if="draft"
    id="lb08-editor"
    class="lb8-section editor"
    :aria-label="t('lb08.editor.title')"
    data-testid="editor"
  >
    <h2>{{ t('lb08.editor.title') }}</h2>

    <p
      v-if="replaying"
      class="lb8-hint"
      data-testid="read-only"
    >
      {{ t('lb08.editor.readOnly') }}
    </p>

    <div class="topline">
      <div class="lb8-field name">
        <label for="lb08-name">{{ t('lb08.editor.nameLabel') }}</label>
        <input
          id="lb08-name"
          class="lb8-control"
          type="text"
          :value="draft.name"
          maxlength="80"
          :disabled="!canEdit"
          @input="rename"
        >
      </div>
      <p class="lb8-row">
        <span class="lb8-chip lb8-chip--board">{{ t('lb08.editor.version', { version: workflow?.version ?? 1 }) }}</span>
        <span
          class="lb8-chip"
          data-testid="saved-state"
        >
          <LbIcon
            :name="dirty ? 'warning' : 'success'"
            :size="14"
            tone="mono"
          />
          {{ dirty ? t('lb08.editor.unsaved') : t('lb08.editor.saved') }}
        </span>
      </p>
    </div>

    <div class="toolbar">
      <LbSegmented
        v-model="view"
        :options="viewOptions"
        :label="t('lb08.editor.view')"
      />
      <div class="add">
        <label
          class="lb-sr-only"
          for="lb08-kind"
        >{{ t('lb08.editor.addLabel') }}</label>
        <select
          id="lb08-kind"
          class="lb8-control kind"
          :value="kind"
          :disabled="!canEdit"
          @change="pickKind"
        >
          <option
            v-for="option in kindOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
        <button
          type="button"
          class="lb8-button"
          :disabled="!canEdit"
          data-testid="add-step"
          @click="addStep"
        >
          {{ pickedStep ? t('lb08.editor.addAfter', { step: pickedStep.label || pickedStep.id }) : t('lb08.editor.addAtEnd') }}
        </button>
      </div>
      <div class="lb8-row">
        <button
          type="button"
          class="lb8-button"
          :disabled="!canEdit || history.length === 0"
          data-testid="undo"
          @click="undo"
        >
          {{ t('lb08.editor.undo') }}
        </button>
        <button
          type="button"
          class="lb8-button"
          :disabled="!canEdit || !dirty"
          data-testid="discard"
          @click="discard"
        >
          {{ t('lb08.editor.discard') }}
        </button>
        <button
          type="button"
          class="lb8-button lb8-button--primary"
          :disabled="!canSave"
          :aria-describedby="saveHint ? 'lb08-save-hint' : undefined"
          data-testid="save"
          @click="save"
        >
          {{ saving ? t('lb08.editor.saving') : t('lb08.editor.save', { version: nextVersion }) }}
        </button>
      </div>
    </div>
    <p
      v-if="saveHint && canEdit"
      id="lb08-save-hint"
      class="lb8-hint"
      data-testid="save-hint"
    >
      {{ saveHint }}
    </p>
    <div
      v-if="saveProblem"
      class="lb8-panel"
      role="alert"
      data-testid="save-problem"
    >
      <template v-if="saveProblem.kind === 'conflict'">
        <p><strong>{{ t('lb08.editor.conflictTitle') }}</strong></p>
        <p>{{ t('lb08.editor.conflictText') }}</p>
      </template>
      <BoardNotice
        v-else
        :kind="saveProblem.kind"
      />
    </div>

    <div class="body">
      <div class="surface">
        <template v-if="view === 'canvas'">
          <component
            :is="Canvas"
            v-if="Canvas"
            @pick="focusInspector"
            @said="say"
          />
          <p
            v-else-if="canvasStatus === 'failed'"
            class="lb8-hint"
            role="status"
          >
            {{ t('lb08.editor.canvasFailed') }}
          </p>
          <p
            v-else
            class="lb8-hint"
            role="status"
          >
            {{ t('lb08.editor.canvasLoading') }}
          </p>
        </template>
        <OutlineEditor
          v-else
          @pick="focusInspector"
          @said="say"
        />
      </div>
      <NodeInspector
        ref="inspector"
        class="side"
        :brief="brief"
      />
    </div>

    <IssueList
      :brief="brief"
      @go-to="focusInspector"
    />

    <p
      class="lb-sr-only"
      role="status"
      aria-live="polite"
      data-testid="said"
    >
      <span :key="saidKey">{{ said }}</span>
    </p>
  </section>
</template>

<style scoped>
.topline {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 20px;
  align-items: end;
  justify-content: space-between;
}

.name {
  flex: 1 1 260px;
  max-width: 460px;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  align-items: center;
}

.add {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.kind {
  width: auto;
  min-width: 150px;
}

.body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 340px);
  gap: 16px;
  align-items: start;
}

.surface {
  min-width: 0;
}

.side {
  min-width: 0;
}

@media (max-width: 900px) {
  .body {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
