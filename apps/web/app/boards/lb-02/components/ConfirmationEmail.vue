<script setup lang="ts">
// <ConfirmationEmail>: the confirmation email a booking would have sent, shown as recorded. This demo
// sends no email to anyone: when a booking is made, the booking code writes the email it would send
// into the database, and this card reads that record back. It says so in a badge and in words, since a
// visitor who sees an email may believe one was sent. The text of the email is shown as plain text,
// with its line breaks, and is never read as markup.
import { LbIcon } from '@lb/icons'
import { useI18n } from 'vue-i18n'

import { typeset } from '~/board-kit/format'

import { formatRecorded } from '../format'
import type { Confirmation } from '../schemas'

defineProps<{
  confirmation: Confirmation | null
  /** Whether the record is being read, was read, or could not be read. */
  status: 'idle' | 'loading' | 'ready' | 'failed'
}>()

const { t, locale } = useI18n()
</script>

<template>
  <section
    id="lb02-email"
    class="email"
    tabindex="-1"
    :aria-label="t('lb02.email.title')"
    data-testid="email"
  >
    <header class="head">
      <h2 class="lb-label">
        {{ t('lb02.email.title') }}
      </h2>
      <p
        class="badge"
        data-testid="email-badge"
      >
        <LbIcon
          name="mail"
          :size="14"
          tone="mono"
        />
        {{ t('lb02.email.badge') }}
      </p>
    </header>
    <p class="help">
      {{ t('lb02.email.help') }}
    </p>
    <p
      v-if="status === 'loading'"
      class="note"
      role="status"
    >
      {{ t('lb02.email.loading') }}
    </p>
    <p
      v-else-if="status === 'failed'"
      class="note"
      role="alert"
    >
      {{ t('lb02.detailFailed') }}
    </p>
    <article
      v-else-if="confirmation"
      class="message"
      :lang="confirmation.language"
    >
      <dl class="fields">
        <div>
          <dt>{{ t('lb02.email.to') }}</dt>
          <dd data-testid="email-to">
            {{ confirmation.to }}
          </dd>
        </div>
        <div>
          <dt>{{ t('lb02.email.subject') }}</dt>
          <dd data-testid="email-subject">
            {{ typeset(confirmation.subject, confirmation.language) }}
          </dd>
        </div>
        <div>
          <dt />
          <dd class="recorded">
            {{ t('lb02.email.recordedAt', { time: formatRecorded(confirmation.recorded_at, locale) }) }}
          </dd>
        </div>
      </dl>
      <p
        class="body"
        data-testid="email-body"
      >
        {{ typeset(confirmation.body, confirmation.language) }}
      </p>
    </article>
  </section>
</template>

<style scoped>
.email {
  display: grid;
  gap: 8px;
  padding: 16px;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-rule);
}

.head {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: center;
  justify-content: space-between;
}

.badge {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 3px 8px;
  font-family: var(--lb-font-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  border: 1.5px dashed var(--lb-ink);
}

.help,
.note {
  max-width: 68ch;
  font-size: 13.5px;
  color: var(--lb-graphite);
}

.message {
  display: grid;
  gap: 10px;
  padding: 14px;
  background: var(--lb-shade);
  border: 1px solid var(--lb-rule);
}

.fields {
  display: grid;
  gap: 4px;
  margin: 0;
  font-size: 13.5px;
}

.fields div {
  display: grid;
  grid-template-columns: 5em minmax(0, 1fr);
  gap: 8px;
}

.fields dt {
  font-family: var(--lb-font-mono);
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.fields dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.recorded {
  font-size: 12px;
  color: var(--lb-graphite);
}

.body {
  font-size: 14px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
</style>
