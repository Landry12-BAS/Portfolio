// The datasheet reading mode: Brief shows the 30-second version of each datasheet;
// Technical shows everything.
import { defineStore } from 'pinia'
import { ref } from 'vue'

/** The two ways to read a datasheet. */
export type ReadingMode = 'technical' | 'brief'

/** Every reading mode, in the order the switch shows them. */
export const READING_MODES: readonly ReadingMode[] = ['technical', 'brief']

/**
 * Tells whether a value is a reading mode. Used on values read back from localStorage,
 * which a visitor (or a script) can change to anything.
 */
export function isReadingMode(value: unknown): value is ReadingMode {
  return READING_MODES.includes(value as ReadingMode)
}

/** The visitor's reading mode, shared by every datasheet page. */
export const useReadingStore = defineStore('reading', () => {
  const mode = ref<ReadingMode>('technical')
  return { mode }
})
