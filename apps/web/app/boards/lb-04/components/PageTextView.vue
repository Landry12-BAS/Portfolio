<script setup lang="ts">
// <PageTextView>: one page of the contract as text, with the characters a finding cites marked. This is the
// PDF viewer's alternative for a reader who cannot see the page, and a reading aid for one who can: the
// text is the very text the server extracted and checked every quote against, so what is marked here is
// exactly what a citation names, whether or not the PDF itself could be drawn. The marks use the page's
// marker colour and are real `mark` elements, which assistive technology announces.
import type { Lb04Citation } from '@lb/contracts'
import { computed } from 'vue'

import { segmentsOf } from '../highlight'

const props = defineProps<{
  text: string
  /** The citations that fall on this page. */
  citations: readonly Lb04Citation[]
}>()

const segments = computed(() => segmentsOf(props.text, props.citations))
</script>

<template>
  <p
    class="text"
    data-testid="page-text"
  >
    <template
      v-for="(segment, index) in segments"
      :key="index"
    >
      <mark v-if="segment.marked">{{ segment.text }}</mark>
      <span v-else>{{ segment.text }}</span>
    </template>
  </p>
</template>

<style scoped>
.text {
  max-width: 72ch;
  max-height: 22rem;
  padding: 10px 12px;
  overflow: auto;
  font-size: 13.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--lb-shade);
}
</style>
