<script setup lang="ts">
// <LbSectionHead>: a numbered section heading in the datasheet style ("3 · Build order").
withDefaults(defineProps<{
  /** Section number, datasheet style. */
  num: string | number
  title: string
  /** Heading level, so the outline stays correct wherever the section sits. */
  level?: 2 | 3
}>(), {
  level: 2,
})
</script>

<template>
  <div class="lb-sec">
    <span
      class="lb-sec__num"
      aria-hidden="true"
    >{{ num }}</span>
    <component
      :is="`h${level}`"
      class="lb-sec__title"
    >
      {{ title }}
    </component>
  </div>
</template>

<style scoped>
.lb-sec {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding-top: 12px;
  margin-bottom: 18px;
  border-top: 2px solid var(--lb-ink);
}

.lb-sec__num {
  min-width: 1.7em;
  font-family: var(--lb-font-mono);
  font-size: 12.5px;
  font-weight: 700;
}

.lb-sec__title {
  font-size: 1.02rem;
  font-weight: 800;
  font-stretch: 125%;
  line-height: 1.25;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
</style>
