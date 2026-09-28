<script setup lang="ts">
import { computed } from 'vue'

import dark from '#brand/lb-mark-dark.svg?url'
import light from '#brand/lb-mark-light.svg?url'

// The mark's construction is 514.5 x 413.5 mark units (brand/README.md).
const RATIO = 514.5 / 413.5

const props = withDefaults(defineProps<{
  /** Rendered height in pixels; the width follows the mark's proportions. */
  height?: number
  /** Accessible name. Pass an empty string when visible text already names the brand. */
  label?: string
}>(), {
  height: 32,
  label: 'LB, Landry Bodjona',
})

const width = computed(() => Math.round(props.height * RATIO * 10) / 10)
</script>

<template>
  <span class="lb-logo">
    <!-- Both files load; the theme tokens decide which one shows, so the swap needs
         no JavaScript and never flashes the wrong mark. -->
    <img
      class="lb-logo__img lb-logo__img--light"
      :src="light"
      :alt="label"
      :width="width"
      :height="height"
    >
    <img
      class="lb-logo__img lb-logo__img--dark"
      :src="dark"
      :alt="label"
      :width="width"
      :height="height"
    >
  </span>
</template>

<style scoped>
.lb-logo {
  display: inline-flex;
  flex: none;
  line-height: 0;
}

.lb-logo__img--light {
  display: var(--lb-show-light);
}

.lb-logo__img--dark {
  display: var(--lb-show-dark);
}
</style>
