import { defineStore } from 'pinia'
import { ref } from 'vue'

export type ReadingMode = 'technical' | 'brief'

export const READING_MODES: readonly ReadingMode[] = ['technical', 'brief']

export function isReadingMode(value: unknown): value is ReadingMode {
  return READING_MODES.includes(value as ReadingMode)
}

/** Brief shows the 30-second version of each datasheet; Technical shows everything. */
export const useReadingStore = defineStore('reading', () => {
  const mode = ref<ReadingMode>('technical')
  return { mode }
})
