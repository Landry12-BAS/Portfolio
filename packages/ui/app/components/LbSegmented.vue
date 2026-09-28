<script setup lang="ts" generic="V extends string">
// <LbSegmented>: a row of toggle buttons where exactly one is on, such as Technical and
// Brief. Each button reports its state with aria-pressed, and the group has a name.
import { LbIcon } from '@lb/icons'

import type { SegmentOption } from '../types/components'

defineProps<{
  options: SegmentOption<V>[]
  /** Names the group for assistive tech. */
  label: string
}>()

// The selected value, two-way bound with v-model.
const model = defineModel<V>({ required: true })
</script>

<template>
  <div
    class="lb-seg"
    role="group"
    :aria-label="label"
  >
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="lb-seg__btn"
      :aria-pressed="model === option.value ? 'true' : 'false'"
      :aria-label="option.iconOnly ? option.label : undefined"
      :title="option.iconOnly ? option.label : undefined"
      @click="model = option.value"
    >
      <LbIcon
        v-if="option.icon"
        :name="option.icon"
        :size="16"
        tone="mono"
      />
      <span v-if="!option.iconOnly">{{ option.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.lb-seg {
  display: inline-flex;
  flex: none;
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
  overflow: hidden;
}

.lb-seg__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 36px;
  min-height: 32px;
  padding: 0 12px;
  font: 600 12px/1 var(--lb-font-sans);
  color: var(--lb-ink);
  background: transparent;
  border: 0;
  cursor: pointer;
}

.lb-seg__btn + .lb-seg__btn {
  border-left: 1.5px solid var(--lb-ink);
}

.lb-seg__btn:hover {
  background: var(--lb-shade);
}

.lb-seg__btn[aria-pressed="true"] {
  background: var(--lb-ink);
  color: var(--lb-sheet);
}

.lb-seg__btn:focus-visible {
  outline-offset: -4px;
}
</style>
