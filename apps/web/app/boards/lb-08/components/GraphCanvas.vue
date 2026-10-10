<script setup lang="ts">
// <GraphCanvas>: the workflow drawn on a canvas, for those who point. It is loaded only when the
// canvas is wanted, because Vue Flow is a large library the rest of the page does not need, and it
// is a picture of the editor's own state: the steps and connections come from the draft in the
// store, and every drag, new connection, move or deletion is handed back to the store, which checks
// the whole workflow again. Vue Flow's own state is never the truth; if the two ever differ, the
// draft wins on the next change. Vue Flow's hidden help texts and its live message are in English,
// so they are replaced here by the visitor's language, and the keys it would otherwise claim for the
// whole page (Backspace, Space, Control, Shift) are given up so the page keeps them.
import { VueFlow, useVueFlow } from '@vue-flow/core'
import type { Connection, NodeChange, NodeDragEvent, NodeMouseEvent, EdgeMouseEvent } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import { storeToRefs } from 'pinia'
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { branchOfHandle, canvasEdges, canvasNodes, edgeIndexOf } from '../graph/canvas'
import type { CanvasInput, CanvasNode } from '../graph/canvas'
import { wordsFrom } from '../graph/words'
import { useLb08Store } from '../store'

import StepEdge from './StepEdge.vue'
import StepNode from './StepNode.vue'

const emit = defineEmits<{
  /** The visitor asked to go to the form of the picked step. */
  pick: []
  /** Something was done that is worth saying aloud. */
  said: [text: string]
}>()

/** The id of this canvas inside Vue Flow, and of the text that tells how to use it with the keyboard. */
const CANVAS_ID = 'lb08-canvas'
const KEYS_ID = 'lb08-canvas-keys'

const { t, te } = useI18n()
const store = useLb08Store()
const { draft, issues, selection, canEdit, workflow, dirty, currentRun } = storeToRefs(store)
const flow = useVueFlow(CANVAS_ID)

const wrapper = ref<HTMLElement>()
const fitPending = ref(false)
const dragging = ref(false)
const shownNodes = shallowRef<CanvasNode[]>([])

const words = wordsFrom((key, params) => t(key, params), key => te(key))

/** The run whose steps the canvas shows: only one of this very version, and only while the draft is as saved. */
const runShown = computed(() => {
  const run = currentRun.value
  const saved = workflow.value
  if (!run || !saved || dirty.value) return undefined
  return run.workflowId === saved.id && run.version === saved.version ? run : undefined
})
const input = computed<CanvasInput | undefined>(() => {
  const graph = draft.value
  if (!graph) return undefined
  return { graph, issues: issues.value, selection: selection.value, editable: canEdit.value, run: runShown.value, helpId: KEYS_ID, words }
})
const nodes = computed(() => (input.value ? canvasNodes(input.value) : []))
const edges = computed(() => (input.value ? canvasEdges(input.value) : []))
const picked = computed(() => selection.value !== undefined)

// While a step is being dragged the nodes are left alone: a change from elsewhere (a run's next
// state, say) must not pull the step out of the visitor's hand.
watch(nodes, (next) => {
  if (!dragging.value) shownNodes.value = next
}, { immediate: true })

/** How long the canvas takes to move the view: no time at all for a visitor who asked for less motion. */
function motionMs(): number {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 0
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200
}

/** Brings every step into view. */
async function fit(): Promise<void> {
  await flow.fitView({ padding: 0.2, duration: motionMs() })
}

/** Zooms in. */
async function zoomIn(): Promise<void> {
  await flow.zoomIn({ duration: motionMs() })
}

/** Zooms out. */
async function zoomOut(): Promise<void> {
  await flow.zoomOut({ duration: motionMs() })
}

// A different workflow, or a step more, may sit outside the view: fit once the new steps are measured.
watch(() => [workflow.value?.id, nodes.value.length] as const, () => {
  fitPending.value = true
})

/** Fits the view once Vue Flow has measured the steps, when something asked for it. */
async function onInitialized(): Promise<void> {
  if (!fitPending.value) return
  fitPending.value = false
  await nextTick()
  await fit()
}

/** The name of a step for a sentence. */
function nameOf(id: string): string {
  const node = draft.value?.nodes.find(candidate => candidate.id === id)
  return node?.label || id
}

/** Takes a step's pick from Vue Flow, which both the pointer and the keyboard cause. */
function pick(id: string): void {
  if (selection.value?.kind === 'node' && selection.value.id === id) return
  store.select({ kind: 'node', id })
  emit('said', t('lb08.canvas.picked', { step: nameOf(id) }))
}

/** Takes the changes Vue Flow made to the steps: picks, and moves made with the keyboard. */
function onNodesChange(changes: NodeChange[]): void {
  for (const change of changes) {
    if (change.type === 'select' && change.selected) {
      pick(change.id)
    }
    else if (change.type === 'select' && selection.value?.kind === 'node' && selection.value.id === change.id) {
      store.select(undefined)
    }
    else if (change.type === 'position' && change.position && change.dragging !== true) {
      store.moveStep(change.id, change.position)
      emit('said', t('lb08.canvas.moved', { step: nameOf(change.id), x: Math.round(change.position.x), y: Math.round(change.position.y) }))
    }
  }
}

/** Starts a drag: until it ends, nothing from outside moves the steps. */
function onDragStart(): void {
  dragging.value = true
}

/** Ends a drag: the step stays where it was dropped, and that place is part of the draft. */
function onDragStop(event: NodeDragEvent): void {
  dragging.value = false
  store.moveStep(event.node.id, event.node.position)
  shownNodes.value = nodes.value
}

/** Picks the step that was clicked. */
function onNodeClick(event: NodeMouseEvent): void {
  pick(event.node.id)
}

/** Picks the connection that was clicked. */
function onEdgeClick(event: EdgeMouseEvent): void {
  const index = edgeIndexOf(event.edge.id)
  if (index !== undefined) store.select({ kind: 'edge', index })
}

/** Clears the pick when the empty canvas is clicked. */
function onPaneClick(): void {
  store.select(undefined)
}

/** Makes a connection from the dot of a step to another step. */
function onConnect(connection: Connection): void {
  store.connect(connection.source, connection.target, branchOfHandle(connection.sourceHandle))
  emit('said', t('lb08.editor.announce.connected', { from: nameOf(connection.source), to: nameOf(connection.target) }))
}

/** The step a key was pressed on, when the key was pressed on a step itself and not on something inside it. */
function stepOf(event: KeyboardEvent): string | undefined {
  const target = event.target
  if (!(target instanceof HTMLElement) || !target.classList.contains('vue-flow__node')) return undefined
  return target.dataset.id
}

/** Gives the keys Vue Flow no longer claims to the steps: Space must not scroll the page, and Delete removes the step. */
function onKeydown(event: KeyboardEvent): void {
  const id = stepOf(event)
  if (id === undefined) return
  if (event.key === ' ') {
    event.preventDefault()
    return
  }
  if ((event.key !== 'Delete' && event.key !== 'Backspace') || !canEdit.value) return
  event.preventDefault()
  const before = draft.value?.nodes.length ?? 0
  const name = nameOf(id)
  store.removeStep(id)
  if ((draft.value?.nodes.length ?? 0) === before) return
  emit('said', t('lb08.editor.announce.removed', { step: name }))
  wrapper.value?.focus()
}
</script>

<template>
  <div class="canvas-block">
    <div
      class="tools"
      role="group"
      :aria-label="t('lb08.canvas.controls')"
    >
      <button
        type="button"
        class="lb8-button"
        data-testid="zoom-in"
        @click="zoomIn"
      >
        {{ t('lb08.canvas.zoomIn') }}
      </button>
      <button
        type="button"
        class="lb8-button"
        data-testid="zoom-out"
        @click="zoomOut"
      >
        {{ t('lb08.canvas.zoomOut') }}
      </button>
      <button
        type="button"
        class="lb8-button"
        data-testid="zoom-fit"
        @click="fit"
      >
        {{ t('lb08.canvas.fit') }}
      </button>
      <button
        type="button"
        class="lb8-button"
        :disabled="!picked"
        data-testid="to-form"
        @click="emit('pick')"
      >
        {{ t('lb08.canvas.toForm') }}
      </button>
    </div>

    <div
      ref="wrapper"
      class="canvas"
      role="group"
      tabindex="-1"
      :aria-label="t('lb08.editor.canvasLabel')"
      data-testid="canvas"
    >
      <VueFlow
        :id="CANVAS_ID"
        :nodes="shownNodes"
        :edges="edges"
        :nodes-focusable="true"
        :edges-focusable="false"
        :delete-key-code="null"
        :selection-key-code="null"
        :multi-selection-key-code="null"
        :pan-activation-key-code="null"
        :zoom-activation-key-code="null"
        :zoom-on-scroll="false"
        :zoom-on-double-click="false"
        :prevent-scrolling="false"
        :snap-to-grid="true"
        :snap-grid="[20, 20]"
        :node-drag-threshold="3"
        :min-zoom="0.3"
        :max-zoom="1.5"
        :connect-on-click="true"
        :fit-view-on-init="true"
        default-marker-color="var(--lb-ink)"
        @keydown="onKeydown"
        @nodes-change="onNodesChange"
        @nodes-initialized="onInitialized"
        @node-click="onNodeClick"
        @node-drag-start="onDragStart"
        @node-drag-stop="onDragStop"
        @edge-click="onEdgeClick"
        @pane-click="onPaneClick"
        @connect="onConnect"
      >
        <template #node-step="nodeProps">
          <StepNode v-bind="nodeProps" />
        </template>
        <template #edge-step="edgeProps">
          <StepEdge v-bind="edgeProps" />
        </template>
      </VueFlow>
    </div>

    <p
      :id="KEYS_ID"
      class="lb8-hint"
      data-testid="canvas-keys"
    >
      {{ t('lb08.editor.canvasKeys') }}
    </p>
    <p class="lb8-hint">
      {{ t('lb08.editor.canvasHelp') }}
    </p>
  </div>
</template>

<style scoped>
.canvas-block {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.tools {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.canvas {
  height: clamp(380px, 60vh, 640px);
  min-width: 0;
  overflow: hidden;
  background: var(--lb-shade);
  border: 1.5px solid var(--lb-ink);
}

/* Vue Flow's own colours are fixed values; here they are the design system's tokens, which have a
   light and a dark value. */
.canvas :deep(.vue-flow__edge-path) {
  stroke: var(--lb-ink);
  stroke-width: 1.75;
}

.canvas :deep(.vue-flow__edge-path.problem) {
  stroke-dasharray: 7 5;
}

.canvas :deep(.vue-flow__edge.selected .vue-flow__edge-path) {
  stroke-width: 3.5;
}

.canvas :deep(.vue-flow__connection-path) {
  stroke: var(--lb-board-mark);
  stroke-width: 2.5;
}

.canvas :deep(.vue-flow__node:focus-visible) {
  outline: 2px solid var(--lb-signal);
  outline-offset: 4px;
}

/* Vue Flow writes its live message in English. The page's own live region says the same in the
   visitor's language, so this one is taken out of the page. */
.canvas :deep([id^="vue-flow__aria-live"]) {
  display: none;
}

@media (prefers-reduced-motion: reduce) {
  .canvas :deep(*) {
    transition: none !important;
    animation: none !important;
  }
}
</style>
