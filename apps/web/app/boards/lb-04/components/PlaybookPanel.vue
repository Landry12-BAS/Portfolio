<script setup lang="ts">
// <PlaybookPanel>: the playbook the reviews are read against, grouped by topic, with what each rule accepts
// and what it flags. The playbook is data the owner edits, kept outside every prompt, and this is the
// service's own account of it: the rules the findings cite are these. It is a disclosure, so a visitor
// who only wants the report never loads it; opening it asks the service once. A rule marked as required
// is one the contract is checked for the absence of, and a finding on it is a clause that is missing.
import type { Lb04PlaybookView } from '@lb/contracts'
import { useI18n } from 'vue-i18n'

import SeverityMark from './SeverityMark.vue'

defineProps<{
  playbook: Lb04PlaybookView | undefined
  status: 'idle' | 'loading' | 'ready' | 'failed'
}>()

const emit = defineEmits<{ open: [], retry: [] }>()

const { t } = useI18n()

/** Asks for the playbook when the disclosure is opened. */
function onToggle(event: Event): void {
  if ((event.target as HTMLDetailsElement).open) emit('open')
}
</script>

<template>
  <details
    class="lb4-section playbook"
    data-testid="playbook"
    @toggle="onToggle"
  >
    <summary>{{ t('lb04.playbook.title') }}</summary>
    <p class="lb4-hint lead">
      {{ t('lb04.playbook.lead') }}
    </p>
    <p
      v-if="status === 'loading'"
      role="status"
    >
      {{ t('lb04.playbook.loading') }}
    </p>
    <p
      v-else-if="status === 'failed'"
      role="alert"
    >
      {{ t('lb04.playbook.failed') }}
      <button
        type="button"
        class="lb4-button lb4-button--quiet"
        @click="emit('retry')"
      >
        {{ t('board.notice.retry') }}
      </button>
    </p>
    <div
      v-else-if="playbook"
      class="topics"
    >
      <section
        v-for="topic in playbook.topics"
        :key="topic.id"
        class="lb4-panel"
      >
        <h3>{{ t(`lb04.topics.${topic.id}`) }}</h3>
        <p class="lb4-hint">
          {{ topic.summary }}
        </p>
        <ul class="rules">
          <li
            v-for="rule in topic.rules"
            :key="rule.id"
            class="rule"
          >
            <p class="name">
              {{ rule.title }}
              <span class="lb4-chip">{{ t(`lb04.playbook.kinds.${rule.kind}`) }}</span>
              <SeverityMark :severity="rule.severity" />
            </p>
            <p><span class="lb-label">{{ t('lb04.playbook.acceptable') }}</span> {{ rule.acceptable }}</p>
            <p><span class="lb-label">{{ rule.kind === 'required' ? t('lb04.playbook.missing') : t('lb04.playbook.redFlag') }}</span> {{ rule.redFlag }}</p>
          </li>
        </ul>
      </section>
    </div>
  </details>
</template>

<style scoped>
summary {
  font-family: var(--lb-font-mono);
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  cursor: pointer;
}

.lead {
  margin: 8px 0;
}

.topics {
  display: grid;
  gap: 10px;
}

.rules {
  display: grid;
  gap: 10px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.rule {
  display: grid;
  gap: 2px;
  font-size: 13.5px;
}

.name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  font-weight: 700;
}
</style>
