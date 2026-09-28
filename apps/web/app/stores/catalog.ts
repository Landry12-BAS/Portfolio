import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import type { Backend, Technique } from '#shared/catalog'
import { filterSystems } from '#shared/catalog'
import { systems } from '#shared/data/systems'

/** The selection guide's filters: pick a back end, a technique, or both. */
export const useCatalogStore = defineStore('catalog', () => {
  const backend = ref<Backend | 'all'>('all')
  const technique = ref<Technique | 'all'>('all')

  const visible = computed(() => filterSystems(systems, { backend: backend.value, technique: technique.value }))
  const filtered = computed(() => backend.value !== 'all' || technique.value !== 'all')

  function clear() {
    backend.value = 'all'
    technique.value = 'all'
  }

  return { backend, technique, visible, filtered, total: systems.length, clear }
})
