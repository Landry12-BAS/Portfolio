<script setup lang="ts">
// <ReplyView>: one prompt's reply to one case, as the graders saw it. Whether it passed, in a word and an icon; which
// model wrote it and how long it took, and whether it came from the cache; the reply itself, as text, with the words
// the other prompt's reply does not have marked (struck through in production's, underlined in the visitor's) and
// every piece a text node; what each grader said, by name in the visitor's language with its own note in English; and,
// for a reply that holds no JSON object where its graders wanted one, that a malformed reply is a failed case and is
// never repaired. A call that got no answer says why, in the gateway's terms.
import { LbIcon } from '@lb/icons'
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DiffPiece } from '../diff'
import type { Lb10Outcome } from '../schemas'
import { useLb10Words } from '../words'

const props = defineProps<{
  /** Whose reply it is: production's prompt or the visitor's. */
  side: 'production' | 'edited'
  outcome: Lb10Outcome
  /** The reply as shown, in pieces marked by the word-level difference with the other reply. */
  pieces: readonly DiffPiece[]
  /** Whether the shown reply was re-indented (its values as written), rather than shown exactly as written. */
  reindented: boolean
  /** Whether the reply holds no JSON object where its graders wanted one. */
  malformed: boolean
}>()

const { t } = useI18n()
const words = useLb10Words()
const id = useId()

const title = computed(() => (props.side === 'production' ? t('lb10.report.changed.production') : t('lb10.report.changed.edited')))
const graders = computed(() => props.outcome.grades.map((grade, index) => ({
  key: index,
  name: words.graderName(grade.kind),
  kind: grade.kind,
  passed: grade.passed,
  detail: grade.detail,
})))
</script>

<template>
  <section
    class="reply"
    :aria-labelledby="`${id}-title`"
    :data-side="side"
    data-testid="reply"
  >
    <h6
      :id="`${id}-title`"
      class="reply-title"
    >
      {{ title }}
    </h6>
    <p
      class="lb10-status"
      data-testid="reply-verdict"
      :data-passed="outcome.passed"
    >
      <LbIcon
        :name="outcome.passed ? 'success' : 'error'"
        :size="16"
        tone="mono"
      />
      <span>{{ outcome.passed ? t('lb10.report.changed.passed') : t('lb10.report.changed.failed') }}</span>
      <span
        v-if="outcome.cached"
        class="lb10-chip"
      >{{ t('lb10.report.changed.fromCache') }}</span>
    </p>
    <p
      v-if="outcome.model !== ''"
      class="lb10-hint"
    >
      {{ t('lb10.report.changed.model', { model: outcome.model, latency: words.duration(outcome.latency_ms) }) }}
    </p>
    <p
      v-if="outcome.error !== null"
      class="note"
      data-testid="reply-no-answer"
    >
      {{ t('lb10.report.changed.noAnswer', { reason: words.gatewayReason(outcome.error) }) }}
    </p>
    <template v-else>
      <p
        v-if="outcome.output === ''"
        class="note"
      >
        {{ t('lb10.report.changed.empty') }}
      </p>
      <pre
        v-else
        class="lb10-text output"
        tabindex="0"
        :aria-label="title"
        data-testid="reply-text"
      ><template
        v-for="(piece, index) in pieces"
        :key="index"
      ><del
        v-if="piece.kind === 'removed'"
        class="lb10-del"
      >{{ piece.text }}</del><ins
        v-else-if="piece.kind === 'added'"
        class="lb10-ins"
      >{{ piece.text }}</ins><span v-else>{{ piece.text }}</span></template></pre>
      <p class="lb10-hint">
        {{ reindented ? t('lb10.report.changed.reindented') : t('lb10.report.changed.asWritten') }}
      </p>
      <p
        v-if="malformed"
        class="note"
        data-testid="reply-malformed"
      >
        {{ t('lb10.report.changed.malformed') }}
      </p>
    </template>
    <div
      v-if="graders.length > 0"
      class="graders"
    >
      <p class="lb10-label">
        {{ t('lb10.report.changed.graders') }}
      </p>
      <ul class="grades">
        <li
          v-for="grader in graders"
          :key="grader.key"
          :data-passed="grader.passed"
        >
          <p class="lb10-status">
            <LbIcon
              :name="grader.passed ? 'check' : 'close'"
              :size="14"
              tone="mono"
            />
            <span>{{ grader.name ?? t('lb10.report.unknownGrader') }}: {{ grader.passed ? t('lb10.report.changed.passed') : t('lb10.report.changed.failed') }}</span>
            <span
              v-if="grader.name === undefined"
              class="lb10-mono"
            >{{ grader.kind }}</span>
          </p>
          <p class="lb10-hint">
            {{ t('lb10.report.changed.graderDetail') }} <q lang="en">{{ grader.detail }}</q>
          </p>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.reply {
  display: grid;
  gap: 6px;
  align-content: start;
  min-width: 0;
}
.reply-title {
  font-size: 13.5px;
  font-weight: 700;
}
.output {
  max-height: 26rem;
}
.note {
  padding: 6px 8px;
  font-size: 13px;
  border: 1.5px dashed var(--lb-ink);
}
.graders {
  display: grid;
  gap: 4px;
}
.grades {
  display: grid;
  gap: 6px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.grades li {
  display: grid;
  gap: 1px;
}
.grades .lb10-status {
  font-size: 13px;
}
.grades .lb10-hint {
  overflow-wrap: anywhere;
}
</style>
