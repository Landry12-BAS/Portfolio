<script setup lang="ts">
// <StepNode>: one step of the workflow as the canvas draws it. It shows the step's number, its kind
// with the icon of the LB set, its name, what the last run did with it (a word and an icon, never
// colour alone) and, when the validator found a problem with it, the problem in a few words. A dot
// on its left takes connections in (a trigger has none: nothing may lead into it) and a dot on its
// right starts them, one for each branch of a step that branches. The step is a group that takes
// focus; Vue Flow adds the keys that pick it and move it.
import { Handle, Position } from '@vue-flow/core'
import { LbIcon } from '@lb/icons'

import type { StepNodeData } from '../graph/canvas'

// Vue Flow hands a node many props that this component does not use; they are not written to the page.
defineOptions({ inheritAttrs: false })

defineProps<{
  /** What the step shows. */
  data: StepNodeData
  /** Whether the step is the one being edited. */
  selected?: boolean
}>()
</script>

<template>
  <div
    class="step"
    :class="[`status-${data.badge?.status ?? 'none'}`, { picked: selected, problem: data.reason !== undefined, branching: data.handles.length > 1 }]"
    data-testid="canvas-step"
  >
    <Handle
      v-if="data.acceptsInput"
      type="target"
      :position="Position.Left"
      :connectable="data.editable"
      class="dot"
    />
    <div class="head">
      <span class="number lb8-mono">{{ data.number }}</span>
      <LbIcon
        :name="data.icon"
        :size="16"
        tone="mono"
      />
      <span class="kind">{{ data.kindLabel }}</span>
    </div>
    <p class="label">
      {{ data.label }}
    </p>
    <p
      v-if="data.badge"
      class="badge"
      data-testid="canvas-badge"
    >
      <LbIcon
        :name="data.badge.icon"
        :size="14"
        tone="mono"
      />
      <span>{{ data.badge.text }}</span>
      <span
        v-if="data.badge.attempt"
        class="lb8-mono"
      >{{ data.badge.attempt }}</span>
    </p>
    <p
      v-if="data.badge?.deadLetter"
      class="badge"
    >
      <LbIcon
        name="incident"
        :size="14"
        tone="mono"
      />
      <span>{{ data.badge.deadLetter }}</span>
    </p>
    <p
      v-if="data.reason"
      class="reason"
      data-testid="canvas-reason"
    >
      <LbIcon
        name="warning"
        :size="14"
        tone="mono"
      />
      <span>{{ data.reason }}</span>
      <span
        v-if="data.moreProblems > 0"
        class="lb8-mono"
      >+{{ data.moreProblems }}</span>
    </p>
    <template
      v-for="handle in data.handles"
      :key="handle.id"
    >
      <Handle
        :id="handle.id"
        type="source"
        :position="Position.Right"
        :connectable="data.editable"
        class="dot"
        :style="{ top: handle.top }"
      />
      <span
        v-if="handle.label"
        class="branch"
        :style="{ top: handle.top }"
      >{{ handle.label }}</span>
    </template>
  </div>
</template>

<style scoped>
.step {
  position: relative;
  box-sizing: border-box;
  display: grid;
  gap: 4px;
  width: 220px;
  min-height: 84px;
  padding: 8px 12px;
  color: var(--lb-ink);
  background: var(--lb-sheet);
  border: 2px solid var(--lb-ink);
  border-radius: 6px;
}

.step.branching {
  padding-right: 58px;
}

.step.picked {
  background: var(--lb-board-tint);
  box-shadow: 0 0 0 3px var(--lb-ink);
}

.step.problem {
  border-style: dashed;
}

.step.status-running {
  border-color: var(--lb-board);
}

.step.status-failed {
  border-style: dashed;
  border-width: 3px;
}

.step.status-skipped {
  color: var(--lb-graphite);
  border-style: dotted;
}

.head {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 11px;
  color: var(--lb-graphite);
}

.number {
  min-width: 14px;
  font-size: 11px;
}

.kind {
  overflow: hidden;
  text-overflow: ellipsis;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  white-space: nowrap;
}

.label {
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  font-size: 13.5px;
  font-weight: 700;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.badge,
.reason {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1.3;
}

.reason {
  align-items: flex-start;
}

.dot {
  width: 12px;
  height: 12px;
  background: var(--lb-sheet);
  border: 2px solid var(--lb-ink);
  border-radius: 50%;
}

.dot:hover {
  background: var(--lb-ink);
}

.branch {
  position: absolute;
  right: 12px;
  font-size: 11px;
  font-weight: 700;
  color: var(--lb-graphite);
  transform: translateY(-50%);
}
</style>
