// Remembers the visitor's reading mode between visits, in the browser only.
//
// The reading mode is a per-visitor convenience, so it lives in localStorage. It is
// restored only once hydration has finished: the server always renders Technical, and
// switching earlier would make the client markup disagree with the server's.
import { watch } from 'vue'

import { isReadingMode, useReadingStore } from '~/stores/reading'

// The localStorage key; the value is always checked before it is used.
const KEY = 'lb-reading'

export default defineNuxtPlugin(() => {
  const reading = useReadingStore()

  onNuxtReady(() => {
    try {
      const saved = localStorage.getItem(KEY)
      if (isReadingMode(saved)) reading.mode = saved
    }
    catch {
      // Storage can be blocked (private windows, strict settings); Technical stays.
    }
    watch(() => reading.mode, (mode) => {
      try {
        localStorage.setItem(KEY, mode)
      }
      catch {
        // The choice then lasts for this visit only.
      }
    })
  })
})
