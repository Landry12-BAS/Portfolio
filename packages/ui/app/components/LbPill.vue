<script setup lang="ts">
withDefaults(defineProps<{
  /** `solid` marks the current or most important state, `dashed` a later one. */
  variant?: 'outline' | 'solid' | 'dashed'
}>(), {
  variant: 'outline',
})
</script>

<template>
  <span
    class="lb-pill"
    :class="`lb-pill--${variant}`"
  ><slot /></span>
</template>

<style scoped>
.lb-pill {
  display: inline-block;
  padding: 4px 9px;
  font-family: var(--lb-font-mono);
  font-size: 10px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
  border: 1.5px solid var(--lb-ink);
  border-radius: 999px;
}

.lb-pill--solid {
  background: var(--lb-ink);
  color: var(--lb-sheet);
}

.lb-pill--dashed {
  border-style: dashed;
}
</style>
