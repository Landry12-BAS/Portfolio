<script setup lang="ts">
// <AppPanel>: the board as an installable app. It starts the board's service worker once the page is
// shown, says in words what the worker keeps (the page and its static files, never a message, the
// calendar or a token), says whether the page is on the device yet, offers the browser's install
// prompt on the visitor's own click, and is honest when there is no connection: the page opens, the
// concierge, the calendar and the recorded samples do not. A browser that cannot install the board
// says so, and the board works the same.
import { LbIcon } from '@lb/icons'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { usePwa } from '../pwa'

const props = defineProps<{
  /** The part of the site the service worker is registered for, such as `/systems/lb-02/`. */
  scope: string
  /** Whether the browser says it has a connection. */
  online: boolean
}>()

const { t } = useI18n()
const { worker, controlled, installed, canInstall, install } = usePwa(props.scope)

const unsupported = computed(() => worker.value === 'unsupported' || worker.value === 'failed')
// The page is on the device once it was loaded through the worker; the first load only starts the worker.
const onDevice = computed(() => worker.value === 'registered' && controlled.value)
const preparing = computed(() => worker.value === 'registered' && !controlled.value)
</script>

<template>
  <section
    class="app"
    :aria-label="t('lb02.app.title')"
    data-testid="app-panel"
  >
    <h2 class="lb-label">
      {{ t('lb02.app.title') }}
    </h2>
    <p class="text">
      {{ t('lb02.app.text') }}
    </p>

    <p
      v-if="unsupported"
      class="status"
      data-testid="app-unsupported"
    >
      {{ t('lb02.app.unsupported') }}
    </p>
    <template v-else>
      <p
        v-if="installed"
        class="status"
        data-testid="app-installed"
      >
        <LbIcon
          name="success"
          :size="16"
          tone="mono"
        />
        {{ t('lb02.app.installed') }}
      </p>
      <template v-else>
        <button
          v-if="canInstall"
          type="button"
          class="button"
          data-testid="app-install"
          @click="install()"
        >
          <LbIcon
            name="download"
            :size="16"
            tone="mono"
          />
          {{ t('lb02.app.install') }}
        </button>
        <p
          v-else
          class="hint"
          data-testid="app-hint"
        >
          {{ t('lb02.app.hint') }}
        </p>
      </template>

      <p
        v-if="onDevice"
        class="status"
        data-testid="app-cached"
      >
        <strong>{{ t('lb02.app.cachedTitle') }}.</strong>
        {{ t('lb02.app.cachedText') }}
      </p>
      <p
        v-else-if="preparing"
        class="status"
        data-testid="app-preparing"
      >
        {{ t('lb02.app.preparing') }}
      </p>
    </template>

    <p
      v-if="!online"
      class="offline"
      role="status"
      data-testid="app-offline"
    >
      <strong>{{ t('lb02.app.offlineTitle') }}.</strong>
      {{ t('lb02.app.offlineText') }}
    </p>
  </section>
</template>

<style scoped>
.app {
  display: grid;
  gap: 10px;
  padding: 16px;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-rule);
}

.text,
.hint,
.status,
.offline {
  max-width: 68ch;
  font-size: 14px;
}

.hint {
  color: var(--lb-graphite);
}

.status {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  align-items: center;
}

.offline {
  padding: 10px 12px;
  background: var(--lb-shade);
  border: 1.5px solid var(--lb-ink);
}

.button {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  justify-self: start;
  padding: 9px 16px;
  font: 600 14px/1 var(--lb-font-sans);
  color: var(--lb-sheet);
  cursor: pointer;
  background: var(--lb-ink);
  border: 1.5px solid var(--lb-ink);
}

.button:hover {
  background: var(--lb-ink-hover);
}
</style>
