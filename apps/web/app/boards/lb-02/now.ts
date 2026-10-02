// A clock a component can read: the current time in Unix milliseconds, kept up to date while the
// component lives. It exists so a hold's countdown and the calendar's idea of which holds have run out
// move on without every component running a timer of its own, and so a test can move the time with
// fake timers. It ticks only in the browser, and only while someone is watching.
import { onScopeDispose, ref } from 'vue'
import type { Ref } from 'vue'

/** Keeps a reference to the current time, updated every `everyMs` milliseconds until the scope ends. */
export function useNow(everyMs = 1_000): Ref<number> {
  const now = ref(Date.now())
  if (typeof window === 'undefined') return now
  const timer = setInterval(() => {
    now.value = Date.now()
  }, everyMs)
  onScopeDispose(() => clearInterval(timer))
  return now
}
