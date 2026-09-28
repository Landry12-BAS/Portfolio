<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{ error: NuxtError }>()

const notFound = computed(() => props.error.statusCode === 404)

useSeoMeta({ title: () => (notFound.value ? 'Part not found' : 'Something went wrong') })

function backToCatalog() {
  clearError({ redirect: '/' })
}
</script>

<template>
  <NuxtLayout>
    <section class="error">
      <p class="lb-label">
        Error {{ error.statusCode }}
      </p>
      <h1>{{ notFound ? 'Part not found' : 'Something went wrong' }}</h1>
      <p v-if="notFound">
        No part in this catalog has that number. The ten systems run from LB-01 to LB-10.
      </p>
      <p v-else>
        The page could not be shown. Reload it, or go back to the catalog.
      </p>
      <button
        type="button"
        class="back"
        @click="backToCatalog"
      >
        Back to the catalog
      </button>
    </section>
  </NuxtLayout>
</template>

<style scoped>
.error {
  display: grid;
  gap: 14px;
  justify-items: start;
  padding-top: 18px;
  border-top: 3px solid var(--lb-ink);
}

h1 {
  font-size: clamp(1.8rem, 1.3rem + 2vw, 2.6rem);
  font-weight: 800;
  font-stretch: 115%;
  line-height: 1.05;
}

p {
  max-width: 60ch;
}

.back {
  padding: 10px 14px;
  font: 600 13px/1 var(--lb-font-sans);
  color: var(--lb-sheet);
  background: var(--lb-ink);
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
  cursor: pointer;
}

.back:hover {
  background: var(--lb-ink-hover);
}
</style>
