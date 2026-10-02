// Whether the browser says it has a network, kept up to date while a component lives. The board uses it
// to be honest about being offline: the composer says messages cannot be sent, and the app panel says
// the page opened from a copy on the device. The browser's word is only a hint (it can say "online"
// on a network that goes nowhere), so nothing here decides to stop trying: the socket and the HTTP
// calls still fail and are worded on their own. The page starts out as online, which is also what a
// server-rendered page assumes, and reads the browser's answer once it is mounted.
import { onMounted, onScopeDispose, ref } from 'vue'
import type { Ref } from 'vue'

/** Keeps a reference to whether the browser reports a connection. */
export function useOnline(): Ref<boolean> {
  const online = ref(true)

  /** Reads the browser's answer. */
  function update(): void {
    online.value = navigator.onLine
  }

  onMounted(() => {
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
  })
  onScopeDispose(() => {
    if (typeof window === 'undefined') return
    window.removeEventListener('online', update)
    window.removeEventListener('offline', update)
  })
  return online
}
