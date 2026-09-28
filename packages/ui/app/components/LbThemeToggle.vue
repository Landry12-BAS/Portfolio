<script setup lang="ts">
import LbSegmented from './LbSegmented.vue'
import type { ColorPreference, SegmentOption } from '../types/components'

const model = defineModel<ColorPreference>({ required: true })

const options: SegmentOption<ColorPreference>[] = [
  { value: 'light', label: 'Light theme', icon: 'sun', iconOnly: true },
  { value: 'dark', label: 'Dark theme', icon: 'moon', iconOnly: true },
  { value: 'system', label: 'Auto' },
]
</script>

<template>
  <LbSegmented
    v-model="model"
    :options="options"
    label="Theme"
  />
</template>
