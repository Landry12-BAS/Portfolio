<script setup lang="ts">
// <BoardTurnstileGate>: the quick check that a visitor is a person, shown only while it is running
// or after it failed, and only when a visitor has started a live run. Cloudflare's widget is
// invisible unless it needs the visitor to do something, in which case it appears inside this box.
// A visitor who only reads, replays a sample or looks at a trace never sees it and never loads
// Cloudflare's script. When the check fails, the board decides what "try again" means.
import { storeToRefs } from 'pinia'
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { startChallenge } from '~/board-kit/turnstile'
import type { RunningChallenge } from '~/board-kit/turnstile'
import { useSessionStore } from '~/stores/session'

const emit = defineEmits<{ retry: [] }>()

const { t } = useI18n()
const session = useSessionStore()
const { challenge, state } = storeToRefs(session)

const container = ref<HTMLElement>()
let widget: RunningChallenge | undefined

/** Takes the widget off the page. */
function removeWidget(): void {
  widget?.remove()
  widget = undefined
}

/** Starts the widget when a check begins that needs one: the test build has no widget, and passes by itself. */
async function runWidget(): Promise<void> {
  const siteKey = state.value?.siteKey
  if (!container.value || !siteKey || state.value?.testMode) return
  removeWidget()
  try {
    widget = await startChallenge(container.value, siteKey, {
      onToken: token => session.provideToken(token),
      onFailure: () => session.provideToken(undefined),
    })
  }
  catch {
    // The script could not be loaded (blocked, or offline): the check failed.
    session.provideToken(undefined)
  }
}

watch(challenge, (next) => {
  if (next === 'running') void runWidget()
  else removeWidget()
}, { immediate: true, flush: 'post' })

onBeforeUnmount(removeWidget)
</script>

<template>
  <div
    v-if="challenge !== 'idle'"
    class="gate"
    data-testid="gate"
  >
    <p
      v-if="challenge === 'running'"
      class="text"
      role="status"
    >
      {{ t('board.gate.checking') }}
    </p>
    <div
      v-else
      class="failed"
      role="alert"
    >
      <p class="text">
        {{ t('board.gate.failed') }}
      </p>
      <button
        type="button"
        class="retry"
        @click="emit('retry')"
      >
        {{ t('board.gate.retry') }}
      </button>
    </div>
    <div
      ref="container"
      class="widget"
    />
  </div>
</template>

<style scoped>
.gate {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  background: var(--lb-board-tint);
  border: 1px dashed var(--lb-board);
}

.text {
  font-size: 14px;
}

.failed {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
}

.retry {
  padding: 6px 12px;
  font: 600 13px/1 var(--lb-font-sans);
  color: var(--lb-ink);
  cursor: pointer;
  background: transparent;
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}

.retry:hover {
  background: var(--lb-shade);
}

.widget:empty {
  display: none;
}
</style>
