import { watch } from 'vue'

import { isReadingMode, useReadingStore } from '~/stores/reading'

const KEY = 'lb-reading'

// The reading mode is a per-visitor convenience, so it lives in localStorage. It is
// restored only once hydration has finished: the server always renders Technical, and
// switching earlier would make the client markup disagree with the server's.
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
