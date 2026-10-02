<script setup lang="ts">
// <StepEdge>: one connection on the canvas, an orthogonal line with an arrowhead. A connection that
// leaves a branching step carries the branch's name on it, and one the validator found a problem with
// carries the problem in a few words, so the reason is at the connection and not only in a list. A
// problem is also marked by a dashed line, because a line's colour alone would say nothing to
// everybody.
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from '@vue-flow/core'
import { LbIcon } from '@lb/icons'
import { computed } from 'vue'

import type { StepEdgeData } from '../graph/canvas'

// Vue Flow hands an edge many props that this component does not use; they are not written to the page.
defineOptions({ inheritAttrs: false })

const props = defineProps<{
  id: string
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
  // Where the line leaves and enters, as Vue Flow names the sides: left, right, top or bottom.
  sourcePosition: string
  targetPosition: string
  markerEnd?: string
  selected?: boolean
  interactionWidth?: number
  data: StepEdgeData
}>()

/** The sides of a step a line can leave from or enter, as the path function names them. */
type Side = Parameters<typeof getSmoothStepPath>[0]['sourcePosition']

/** The line's path and the place for its label, from where it starts and where it ends. */
const drawn = computed(() => getSmoothStepPath({
  sourceX: props.sourceX,
  sourceY: props.sourceY,
  sourcePosition: props.sourcePosition as Side,
  targetX: props.targetX,
  targetY: props.targetY,
  targetPosition: props.targetPosition as Side,
  borderRadius: 8,
}))

const hasLabel = computed(() => props.data.branch !== undefined || props.data.reason !== undefined)
const labelStyle = computed(() => ({
  transform: `translate(-50%, -50%) translate(${drawn.value[1]}px, ${drawn.value[2]}px)`,
}))
</script>

<template>
  <BaseEdge
    :id="id"
    :path="drawn[0]"
    :marker-end="markerEnd"
    :interaction-width="interactionWidth"
    :class="{ problem: data.reason !== undefined }"
  />
  <EdgeLabelRenderer v-if="hasLabel">
    <div
      class="label nodrag nopan"
      :class="{ picked: selected, problem: data.reason !== undefined }"
      :style="labelStyle"
      data-testid="canvas-edge-label"
    >
      <span v-if="data.branch">{{ data.branch }}</span>
      <span
        v-if="data.reason"
        class="reason"
      >
        <LbIcon
          name="warning"
          :size="12"
          tone="mono"
        />
        {{ data.reason }}
      </span>
    </div>
  </EdgeLabelRenderer>
</template>

<style scoped>
.label {
  position: absolute;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  max-width: 190px;
  padding: 1px 6px;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.3;
  color: var(--lb-ink);
  pointer-events: all;
  background: var(--lb-sheet);
  border: 1px solid var(--lb-rule);
  border-radius: 4px;
}

.label.picked {
  border: 2px solid var(--lb-ink);
}

.label.problem {
  border-style: dashed;
  border-color: var(--lb-ink);
}

.reason {
  display: inline-flex;
  gap: 3px;
  align-items: flex-start;
  font-weight: 600;
}
</style>
