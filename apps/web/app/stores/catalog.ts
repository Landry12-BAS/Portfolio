// The selection guide's filter state. The store holds only the visitor's two choices;
// components apply them to the datasheets in the visitor's language.
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import type { Backend, Technique } from '#shared/catalog'
import { filterSystems } from '#shared/catalog'
import type { System } from '#shared/schema/system'

/** The selection guide's filters: pick a back end, a technique, or both. */
export const useCatalogStore = defineStore('catalog', () => {
  const backend = ref<Backend | 'all'>('all')
  const technique = ref<Technique | 'all'>('all')
  // True while at least one filter is on, to show the "Clear filters" button.
  const filtered = computed(() => backend.value !== 'all' || technique.value !== 'all')

  /** Returns the datasheets that pass both filters, in catalog order. */
  function visibleIn(list: readonly System[]): System[] {
    return filterSystems(list, { backend: backend.value, technique: technique.value })
  }

  /** Switches both filters off. */
  function clear() {
    backend.value = 'all'
    technique.value = 'all'
  }

  return { backend, technique, filtered, visibleIn, clear }
})
