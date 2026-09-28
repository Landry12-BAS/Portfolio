<script setup lang="ts">
// <LbThemeToggle>: the light, dark and automatic theme switch in the toolbar. Its text
// comes from the app, so it speaks the page's language; English is the default.
import { computed } from 'vue'

import LbSegmented from './LbSegmented.vue'
import type { ColorPreference, SegmentOption, ThemeToggleLabels } from '../types/components'

const props = withDefaults(defineProps<{
  /** The group's name and each button's name, in the page's language. */
  labels?: ThemeToggleLabels
}>(), {
  labels: () => ({ group: 'Theme', light: 'Light theme', dark: 'Dark theme', system: 'Auto' }),
})

// The visitor's theme choice, two-way bound with v-model.
const model = defineModel<ColorPreference>({ required: true })

// Light and dark show only their icon (named for screen readers); Auto shows its text.
const options = computed<SegmentOption<ColorPreference>[]>(() => [
  { value: 'light', label: props.labels.light, icon: 'sun', iconOnly: true },
  { value: 'dark', label: props.labels.dark, icon: 'moon', iconOnly: true },
  { value: 'system', label: props.labels.system },
])
</script>

<template>
  <LbSegmented
    v-model="model"
    :options="options"
    :label="labels.group"
  />
</template>
