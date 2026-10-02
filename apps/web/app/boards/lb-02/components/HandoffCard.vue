<script setup lang="ts">
// <HandoffCard>: what a person would receive when the concierge hands a conversation over: why it was
// handed over, what had been collected, and every line said. A visitor sees it appear when the
// conversation ends this way, and the keyboard's focus is moved to it, since the message field is no
// longer there to keep it. The reason is worded by this page from the kind the server names, and an
// unknown one reads as a plain handoff; the summary and the transcript are the server's text and are
// shown as plain text only. Nobody is notified in this demo, and the card says so.
import { LbIcon } from '@lb/icons'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { typeset } from '~/board-kit/format'

import type { Handoff } from '../schemas'

/** The reasons for a handoff that this page words (lb02/handoff.py in the back end). */
const KNOWN_REASONS: ReadonlySet<string> = new Set(['asked_for_person', 'out_of_scope', 'cannot_help', 'message_limit', 'budget', 'unavailable', 'unchecked', 'abuse'])

const props = defineProps<{
  handoff: Handoff | null
  /** Whether the case file is being read, was read, or could not be read. */
  status: 'idle' | 'loading' | 'ready' | 'failed'
  /** The language of the conversation, for the summary and the transcript. */
  language: string
}>()

const { t } = useI18n()
const card = ref<HTMLElement>()

/** Says which of the page's wordings fits the reason the server gave. */
function reasonKey(reason: string): string {
  return KNOWN_REASONS.has(reason) ? reason : 'other'
}

/** Puts the keyboard's focus on the card. */
function focus(): void {
  card.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <section
    id="lb02-handoff"
    ref="card"
    class="handoff"
    tabindex="-1"
    :aria-label="t('lb02.handoff.title')"
    data-testid="handoff"
  >
    <h2 class="title">
      <LbIcon
        name="support"
        :size="18"
        tone="mono"
      />
      {{ t('lb02.handoff.title') }}
    </h2>
    <p class="help">
      {{ t('lb02.handoff.help') }}
    </p>
    <p
      v-if="status === 'loading'"
      class="note"
      role="status"
    >
      {{ t('lb02.handoff.loading') }}
    </p>
    <p
      v-else-if="status === 'failed'"
      class="note"
      role="alert"
    >
      {{ t('lb02.detailFailed') }}
    </p>
    <template v-else-if="props.handoff">
      <dl class="facts">
        <div>
          <dt>{{ t('lb02.handoff.reason') }}</dt>
          <dd data-testid="handoff-reason">
            {{ t(`lb02.handoff.reasons.${reasonKey(props.handoff.reason)}`) }}
          </dd>
        </div>
        <div>
          <dt>{{ t('lb02.handoff.summary') }}</dt>
          <dd
            data-testid="handoff-summary"
            :lang="language"
          >
            {{ props.handoff.summary === '' ? t('lb02.handoff.noSummary') : typeset(props.handoff.summary, language) }}
          </dd>
        </div>
      </dl>
      <h3 class="lb-label">
        {{ t('lb02.handoff.transcript') }}
      </h3>
      <ol
        class="transcript"
        data-testid="handoff-transcript"
      >
        <li
          v-for="line in props.handoff.transcript"
          :key="line.position"
          :data-role="line.role"
        >
          <span class="role">{{ t(`lb02.handoff.roles.${line.role}`) }}</span>
          <span
            class="text"
            :lang="language"
          >{{ typeset(line.text, language) }}</span>
        </li>
      </ol>
    </template>
  </section>
</template>

<style scoped>
.handoff {
  display: grid;
  gap: 8px;
  padding: 16px;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-ink);
}

.title {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 17px;
  font-weight: 800;
}

.help,
.note {
  max-width: 68ch;
  font-size: 13.5px;
  color: var(--lb-graphite);
}

.facts {
  display: grid;
  gap: 8px;
  margin: 0;
  font-size: 14px;
}

.facts dt {
  font-family: var(--lb-font-mono);
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.facts dd {
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.transcript {
  display: grid;
  gap: 6px;
  padding: 0;
  margin: 0;
  font-size: 13.5px;
  list-style: none;
}

.transcript li {
  display: grid;
  grid-template-columns: 6.5em minmax(0, 1fr);
  gap: 8px;
}

.role {
  font-family: var(--lb-font-mono);
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.text {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
</style>
