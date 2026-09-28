<script setup lang="ts">
// The error page, in the visitor's language: "Part not found" for an unknown part
// number (a real 404), and a generic message with a way back for anything else.
import type { NuxtError } from '#app'

const props = defineProps<{ error: NuxtError }>()
const { t } = useI18n()
const localePath = useLocalePath()

const notFound = computed(() => props.error.statusCode === 404)

useSeoMeta({ title: () => (notFound.value ? t('error.notFound') : t('error.generic')) })

/** Clears the error and returns to the catalog, in the visitor's language. */
function backToCatalog() {
  clearError({ redirect: localePath('/') })
}
</script>

<template>
  <NuxtLayout>
    <section class="error">
      <p class="lb-label">
        {{ t('error.code', { code: error.statusCode }) }}
      </p>
      <h1>{{ notFound ? t('error.notFound') : t('error.generic') }}</h1>
      <p v-if="notFound">
        {{ t('error.notFoundText') }}
      </p>
      <p v-else>
        {{ t('error.genericText') }}
      </p>
      <button
        type="button"
        class="back"
        @click="backToCatalog"
      >
        {{ t('error.back') }}
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
