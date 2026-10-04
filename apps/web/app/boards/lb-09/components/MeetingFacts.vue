<script setup lang="ts">
// <MeetingFacts>: what the board knows about the meeting, in the side column: which mode ran and
// what that meant for the audio, which transcriber heard it, the language it heard, the length
// measured from the decoded audio, the model calls so far and the items the checks dropped, and that
// the audio was deleted once transcribed. The Brief reading keeps the mode and the audio's fate and
// leaves out the counts.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { Meeting } from '../schemas'

const props = defineProps<{
  /** The meeting, or undefined before one has started. */
  meeting: Meeting | undefined
  /** The Brief reading leaves out the counts. */
  brief: boolean
}>()

const { t, locale } = useI18n()

/** Names a language from its code in the visitor's language, or gives the code back. */
function languageName(code: string): string {
  if (code === '') return t('lb09.facts.unknown')
  try {
    return new Intl.DisplayNames(locale.value, { type: 'language' }).of(code) ?? code.toUpperCase()
  }
  catch {
    return code.toUpperCase()
  }
}

const rows = computed(() => {
  const meeting = props.meeting
  if (!meeting) return []
  const all = [
    { key: 'mode', label: t('lb09.facts.mode'), value: t(`lb09.facts.modes.${meeting.mode}`) },
    { key: 'audio', label: t('lb09.facts.audio'), value: t('lb09.facts.audioValue') },
    { key: 'transcriber', label: t('lb09.facts.transcriber'), value: meeting.transcriber === '' ? t('lb09.facts.unknown') : meeting.transcriber },
    { key: 'language', label: t('lb09.facts.language'), value: languageName(meeting.heard_language) },
    { key: 'duration', label: t('lb09.facts.duration'), value: t('lb09.facts.seconds', { seconds: meeting.duration_seconds.toFixed(1) }) },
    { key: 'calls', label: t('lb09.facts.modelCalls'), value: String(meeting.model_calls) },
    { key: 'dropped', label: t('lb09.facts.dropped'), value: String(meeting.dropped_items) },
  ]
  return props.brief ? all.filter(row => row.key === 'mode' || row.key === 'audio') : all
})
</script>

<template>
  <section
    class="facts"
    data-testid="facts"
    :aria-labelledby="'lb09-facts-title'"
  >
    <h2
      id="lb09-facts-title"
      class="lb-label"
    >
      {{ t('lb09.facts.title') }}
    </h2>
    <p
      v-if="!meeting"
      class="note"
    >
      {{ t('lb09.facts.none') }}
    </p>
    <dl
      v-else
      class="rows"
    >
      <template
        v-for="row in rows"
        :key="row.key"
      >
        <dt>{{ row.label }}</dt>
        <dd :data-fact="row.key">
          {{ row.value }}
        </dd>
      </template>
    </dl>
    <p class="note">
      {{ t('lb09.facts.labels') }}
    </p>
  </section>
</template>

<style scoped>
.facts {
  display: grid;
  gap: 8px;
}

.note {
  font-size: 13px;
  color: var(--lb-graphite);
}

.rows {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  margin: 0;
  font-size: 13px;
}

dt {
  color: var(--lb-graphite);
}

dd {
  margin: 0;
  font-family: var(--lb-font-mono);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
</style>
