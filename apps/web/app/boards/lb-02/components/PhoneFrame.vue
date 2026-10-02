<script setup lang="ts">
// <PhoneFrame>: the concierge's chat drawn as a phone, because that is where a customer would use it:
// a bezel, a header with the roastery's name and the state of the connection, and a screen for the
// chat. The state is written in words beside an icon, and announced politely when it changes, so a
// dropped connection is never only a colour. On a narrow screen the bezel falls away and the chat
// fills the width, as it would on a phone, and installed as an app it does the same.
import { LbIcon } from '@lb/icons'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { RECONNECT_ATTEMPTS } from '../socket'
import type { ConnectionStatus } from '../socket'

const props = defineProps<{
  /** The state of the connection, or `replay` for a recording. */
  status: ConnectionStatus | 'replay'
  /** How many new attempts have been made since the connection dropped. */
  attempt: number
}>()

const { t } = useI18n()

const statusText = computed(() => t(`lb02.phone.status.${props.status}`, { attempt: props.attempt, max: RECONNECT_ATTEMPTS }))
const icon = computed(() => {
  switch (props.status) {
    case 'open': return 'live'
    case 'replay': return 'replay'
    case 'connecting':
    case 'reconnecting': return 'clock'
    default: return 'pause'
  }
})
</script>

<template>
  <section
    class="phone"
    :aria-label="t('lb02.phone.label')"
    data-testid="phone"
  >
    <header class="bar">
      <p class="title">
        {{ t('lb02.phone.title') }}
      </p>
      <p
        class="status"
        role="status"
        :data-status="status"
        data-testid="connection"
      >
        <LbIcon
          :name="icon"
          :size="14"
          tone="mono"
        />
        <span>{{ statusText }}</span>
      </p>
    </header>
    <div class="screen">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.phone {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 8px;
  width: 100%;
  max-width: 380px;
  padding: 12px 10px 14px;
  background: var(--lb-sheet);
  border: 3px solid var(--lb-ink);
  border-radius: 34px;
}

.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 2px 10px;
  padding: 6px 12px 0;
}

.title {
  font-size: 14px;
  font-weight: 800;
  font-stretch: 112%;
}

.status {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-family: var(--lb-font-mono);
  font-size: 10.5px;
  letter-spacing: 0.04em;
  color: var(--lb-graphite);
}

.status[data-status="open"] {
  color: var(--lb-ink);
}

.screen {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 8px;
  min-height: 0;
  height: min(620px, 78vh);
  min-height: 440px;
  overflow: hidden;
  background: var(--lb-sheet);
  border: 1px solid var(--lb-rule);
  border-radius: 22px;
}

@media (max-width: 480px), (display-mode: standalone) {
  .phone {
    max-width: none;
    padding: 0;
    border: 0;
    border-radius: 0;
  }

  .screen {
    border-radius: 12px;
  }
}
</style>
