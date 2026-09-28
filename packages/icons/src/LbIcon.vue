<script setup lang="ts">
// <LbIcon>: draws one icon from the LB set, inline, in the text colour with the accent in
// signal blue. Decorative unless given a label, so screen readers skip it by default.
import { computed } from 'vue'

import { icons } from './generated/icons'
import type { IconName } from './generated/icons'

const props = withDefaults(defineProps<{
  /** The icon to draw. */
  name: IconName
  /** Width and height. A number means pixels; a string can be any CSS length. */
  size?: number | string
  /** Accessible name. Without one the icon is decorative and hidden from assistive tech. */
  label?: string
  /** `duo` paints the accent in signal blue; `mono` paints everything in currentColor. */
  tone?: 'duo' | 'mono'
}>(), {
  size: 24,
  label: undefined,
  tone: 'duo',
})

// The icon's paths, in paint order: accents last, so they sit on top.
const paths = computed(() => icons[props.name])
</script>

<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    :width="size"
    :height="size"
    fill="none"
    stroke="currentColor"
    stroke-width="2.5"
    stroke-linecap="butt"
    stroke-linejoin="miter"
    :class="['lb-icon', { 'lb-icon--mono': tone === 'mono' }]"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
  >
    <path
      v-for="(path, index) in paths"
      :key="index"
      :d="path.d"
      :class="path.accent ? (path.fill ? 'lb-icon__accent-fill' : 'lb-icon__accent') : undefined"
      :fill="path.fill ? 'currentColor' : undefined"
      :stroke="path.fill ? 'none' : undefined"
      :stroke-linecap="path.accent && !path.fill ? 'round' : undefined"
    />
  </svg>
</template>

<style>
/* The accent reads a custom property so each theme can tune it (the dark theme uses
   the ribbon's highlight); the fallback is the light logo's ribbon blue. */
.lb-icon__accent {
  stroke: var(--lb-icon-accent, #045efe);
}

.lb-icon__accent-fill {
  fill: var(--lb-icon-accent, #045efe);
}

.lb-icon--mono {
  --lb-icon-accent: currentColor;
}
</style>
