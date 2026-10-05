<script setup lang="ts">
// <ChangedCase>: one case whose grade changed between production's prompt and the visitor's. Its ID and difficulty,
// whether it improved or regressed (a word and an icon), what the model was given and what the golden set expects, as
// text, and the two replies side by side (stacked on a narrow screen) with the words only one of them has marked. A
// reply that is one JSON document is shown re-indented, every value as the model wrote it, unless the visitor asks to
// see both exactly as written; both replies are always shown the same way, so the marks compare like with like.
import { LbIcon } from '@lb/icons'
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { hasChanges, wordDiff } from '../diff'
import { reindentJson } from '../json'
import { isMalformed } from '../report'
import type { Lb10ChangedCase, Lb10Outcome } from '../schemas'
import { useLb10Words } from '../words'
import ReplyView from './ReplyView.vue'

const props = defineProps<{
  change: Lb10ChangedCase
  /** What the target answers with, which says whether a reply must hold a JSON object. */
  output: 'json' | 'text' | 'tool_calls'
}>()

const { t } = useI18n()
const words = useLb10Words()
const id = useId()

const asWritten = ref(false)

/** Shows a reply re-indented when it is one JSON document and the visitor has not asked for it as written. */
function shown(outcome: Lb10Outcome): { text: string, reindented: boolean } {
  if (asWritten.value) return { text: outcome.output, reindented: false }
  const reindented = reindentJson(outcome.output)
  return reindented === undefined ? { text: outcome.output, reindented: false } : { text: reindented, reindented: true }
}

const production = computed(() => shown(props.change.production))
const edited = computed(() => shown(props.change.edited))
const diff = computed(() => wordDiff(production.value.text, edited.value.text))
const canReindent = computed(() => reindentJson(props.change.production.output) !== undefined || reindentJson(props.change.edited.output) !== undefined)
const inputs = computed(() => Object.entries(props.change.inputs))
const expected = computed(() => JSON.stringify(props.change.expected, null, 2))
</script>

<template>
  <article
    class="case"
    :aria-labelledby="`${id}-title`"
    data-testid="changed-case"
    :data-change="change.change"
    :data-case="change.case_id"
  >
    <h5
      :id="`${id}-title`"
      class="case-title"
    >
      <LbIcon
        :name="change.change === 'improved' ? 'success' : 'error'"
        :size="16"
        tone="mono"
      />
      <span>{{ change.change === 'improved' ? t('lb10.report.changed.improved') : t('lb10.report.changed.regressed') }}:</span>
      <span class="lb10-mono">{{ t('lb10.report.changed.case', { id: change.case_id }) }}</span>
      <span class="lb10-chip">{{ t('lb10.report.changed.difficulty', { difficulty: words.difficultyWord(change.difficulty) }) }}</span>
    </h5>
    <details class="lb10-details">
      <summary>{{ t('lb10.report.changed.inputs') }}</summary>
      <dl class="inputs">
        <div
          v-for="[name, value] in inputs"
          :key="name"
        >
          <dt class="lb10-mono">
            {{ name }}
          </dt>
          <dd>
            <pre
              class="lb10-text"
              tabindex="0"
              :aria-label="`${t('lb10.report.changed.inputs')}: ${name}`"
            >{{ value }}</pre>
          </dd>
        </div>
      </dl>
      <p class="lb10-label">
        {{ t('lb10.report.changed.expected') }}
      </p>
      <pre
        class="lb10-text"
        tabindex="0"
        :aria-label="t('lb10.report.changed.expected')"
      >{{ expected }}</pre>
    </details>
    <div class="lb10-row">
      <button
        v-if="canReindent"
        type="button"
        class="lb10-button lb10-button--quiet"
        :aria-pressed="asWritten"
        data-testid="as-written"
        @click="asWritten = !asWritten"
      >
        {{ t('lb10.report.changed.showAsWritten') }}
      </button>
    </div>
    <p
      v-if="!diff.compared"
      class="lb10-hint"
    >
      {{ t('lb10.report.changed.notCompared') }}
    </p>
    <p
      v-else-if="!diff.related"
      class="lb10-hint"
      data-testid="diff-unrelated"
    >
      {{ t('lb10.report.changed.unrelated') }}
    </p>
    <p
      v-else-if="hasChanges(diff)"
      class="lb10-hint"
      data-testid="diff-note"
    >
      {{ t('lb10.report.changed.diffNote') }}
    </p>
    <div class="pair">
      <ReplyView
        side="production"
        :outcome="change.production"
        :pieces="diff.production"
        :reindented="production.reindented"
        :malformed="isMalformed(change.production, output)"
      />
      <ReplyView
        side="edited"
        :outcome="change.edited"
        :pieces="diff.edited"
        :reindented="edited.reindented"
        :malformed="isMalformed(change.edited, output)"
      />
    </div>
    <p class="lb10-hint">
      {{ t('lb10.report.changed.cut') }}
    </p>
  </article>
</template>

<style scoped>
.case {
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 12px 14px;
  background: var(--lb-sheet);
  border: 1px solid var(--lb-rule);
  container-type: inline-size;
}
.case-title {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 8px;
  align-items: center;
  font-size: 14px;
  font-weight: 700;
}
.inputs {
  display: grid;
  gap: 6px;
  margin: 0 0 8px;
}
.inputs dd {
  margin: 2px 0 0;
}
.inputs .lb10-text {
  max-height: 12rem;
}
.pair {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
}
@container (min-width: 640px) {
  .pair {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
