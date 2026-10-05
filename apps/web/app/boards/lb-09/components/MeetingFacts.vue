<script setup lang="ts">
// <MeetingFacts>: what the board knows about the meeting, in the side column: which mode ran and
// what that meant for the audio (held until it is transcribed, then deleted), which transcriber heard
// it, the language it heard, the length measured from the decoded audio, the chat calls so far (the
// transcription in fast mode is a model call of its own, which the Scope counts with them) and the
// items the checks dropped. What is not known yet says so while the meeting runs, and says "none" once
// it is over. The Brief reading keeps the mode and the audio's fate and leaves out the counts.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { decimalSeconds, languageName } from '../format'
import { isOver } from '../schemas'
import type { Meeting } from '../schemas'

const props = defineProps<{
  /** The meeting, or undefined before one has started. */
  meeting: Meeting | undefined
  /** The Brief reading leaves out the counts. */
  brief: boolean
}>()

const { t, locale } = useI18n()

// The stages before the audio has been transcribed, while it still waits in the service.
const BEFORE_TRANSCRIBED = new Set(['received', 'decoding', 'transcribing'])

/** Says what is known of a value: the value, "not yet known" while the meeting runs, or "none" once it is over. */
function known(value: string, over: boolean): string {
  if (value !== '') return value
  return over ? t('lb09.facts.noValue') : t('lb09.facts.unknown')
}

const rows = computed(() => {
  const meeting = props.meeting
  if (!meeting) return []
  const over = isOver(meeting)
  const held = !over && BEFORE_TRANSCRIBED.has(meeting.stage)
  const length = meeting.duration_seconds > 0 ? t('lb09.facts.seconds', { seconds: decimalSeconds(meeting.duration_seconds, locale.value) }) : ''
  const language = meeting.heard_language.trim() === '' ? '' : languageName(meeting.heard_language, locale.value)
  const all = [
    { key: 'mode', label: t('lb09.facts.mode'), value: t(`lb09.facts.modes.${meeting.mode}`) },
    { key: 'audio', label: t('lb09.facts.audio'), value: held ? t('lb09.facts.audioHeld') : t('lb09.facts.audioValue') },
    { key: 'transcriber', label: t('lb09.facts.transcriber'), value: known(meeting.transcriber, over) },
    { key: 'language', label: t('lb09.facts.language'), value: known(language, over) },
    { key: 'duration', label: t('lb09.facts.duration'), value: known(length, over) },
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
