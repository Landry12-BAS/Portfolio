<script setup lang="ts">
// <PromptEditor>: "2. Your version of the prompt". A plain text field that starts from production's prompt, with a
// counter of characters against the service's limit (counted as the service counts them), the pack's variables shown
// as kept or missing as the visitor types, any name in double braces the pack has no variable for, how the edit
// differs from production, and a button that puts production's prompt back. What would stop the run is listed under
// the field before anything is sent; when the service refuses the prompt anyway (422), its problems are listed in the
// same place, in the visitor's language, and stay until the prompt is changed. The field is an ordinary one: Tab
// leaves it, as the note says, and nothing traps the keyboard. The prompt lives in this page's memory only.
import { LbIcon } from '@lb/icons'
import { storeToRefs } from 'pinia'
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { issuesFromService, lineChange, promptLength, unknownVariables, variableStates } from '../prompt'
import type { PromptIssue } from '../prompt'
import { useLb10Store } from '../store'
import { useLb10Words } from '../words'

defineProps<{
  /** Whether a run is being started or followed: the prompt it took cannot be changed under it. */
  busy: boolean
}>()

const { t } = useI18n()
const words = useLb10Words()
const store = useLb10Store()
const { draft, target, limits, issues, unchanged, refused } = storeToRefs(store)
const id = useId()

const max = computed(() => limits.value?.max_prompt_chars ?? 0)
const length = computed(() => promptLength(draft.value))
const variables = computed(() => (target.value ? variableStates(draft.value, target.value.variables) : []))
const strangers = computed(() => (target.value ? unknownVariables(draft.value, target.value.variables) : []))
const change = computed(() => (target.value ? lineChange(target.value.system_prompt, draft.value) : { removed: 0, added: 0 }))
const refusedIssues = computed(() => {
  const refusal = refused.value
  if (!refusal || !target.value) return []
  return issuesFromService(refusal.problems.map(problem => problem.code), refusal.prompt, target.value.variables, max.value)
})
const unknownRefusals = computed(() => {
  const known = new Set(refusedIssues.value.map(issue => issue.code))
  return (refused.value?.problems ?? []).filter(problem => !known.has(problem.code as PromptIssue['code']))
})
const changeText = computed(() => {
  const parts: string[] = []
  if (change.value.removed > 0) parts.push(words.counted('lb10.editor.removedLines', change.value.removed))
  if (change.value.added > 0) parts.push(words.counted('lb10.editor.addedLines', change.value.added))
  return parts.length > 0 ? parts.join(', ') : t('lb10.editor.reworded')
})
const describedBy = computed(() => [`${id}-count`, `${id}-keys`, issues.value.length > 0 ? `${id}-checks` : '', refused.value ? `${id}-refused` : ''].filter(part => part !== '').join(' '))

/** Writes a variable as the prompt writes it, in double braces. */
function braced(name: string): string {
  return `{{${name}}}`
}

/** Says one problem of a prompt in the visitor's language. */
function issueText(issue: PromptIssue): string {
  switch (issue.code) {
    case 'empty': return t('lb10.editor.checks.empty')
    case 'too_long': return t('lb10.editor.checks.tooLong', { over: words.number(issue.length - issue.max), length: words.number(issue.length), max: words.number(issue.max) })
    case 'not_text': return t('lb10.editor.checks.notText')
    case 'missing_variables': return t('lb10.editor.checks.missing', { names: issue.names.map(braced).join(', ') })
    case 'unknown_variables': return t('lb10.editor.checks.unknown', { names: issue.names.map(braced).join(', ') })
  }
}

/** Takes what the visitor typed. */
function onInput(event: Event): void {
  store.setDraft((event.target as HTMLTextAreaElement).value)
}
</script>

<template>
  <section
    id="lb10-editor"
    class="lb10-section"
    :aria-labelledby="`${id}-title`"
    data-testid="prompt-editor"
  >
    <h2 :id="`${id}-title`">
      {{ t('lb10.editor.title') }}
    </h2>
    <div
      v-if="target"
      class="field"
    >
      <label
        :for="`${id}-prompt`"
        class="field-label"
      >{{ t('lb10.editor.label') }}</label>
      <textarea
        :id="`${id}-prompt`"
        class="control"
        :value="draft"
        rows="14"
        lang="en"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        :readonly="busy"
        :aria-invalid="issues.length > 0 || refused !== undefined"
        :aria-describedby="describedBy"
        data-testid="prompt-input"
        @input="onInput"
      />
      <div class="under">
        <p
          :id="`${id}-count`"
          class="lb10-nums count"
          :class="{ 'count--over': length > max }"
          data-testid="prompt-count"
        >
          {{ t('lb10.editor.counter', { count: words.number(length), max: words.number(max) }) }}
        </p>
        <button
          type="button"
          class="lb10-button lb10-button--quiet"
          :disabled="unchanged || busy"
          data-testid="reset-prompt"
          @click="store.resetDraft()"
        >
          {{ t('lb10.editor.reset') }}
        </button>
      </div>
      <p
        :id="`${id}-keys`"
        class="lb10-hint"
      >
        {{ t('lb10.editor.keyboard') }}
      </p>
    </div>
    <div
      v-if="target && variables.length + strangers.length > 0"
      class="variables"
      data-testid="prompt-variables"
    >
      <p class="lb10-label">
        {{ t('lb10.editor.variables') }}
      </p>
      <ul class="lb10-chips">
        <li
          v-for="variable in variables"
          :key="variable.name"
          class="lb10-chip"
          :class="{ 'lb10-chip--bad': !variable.kept }"
          :data-kept="variable.kept"
        >
          <LbIcon
            :name="variable.kept ? 'check' : 'error'"
            :size="12"
            tone="mono"
          />
          <span>{{ braced(variable.name) }}</span>
          <span>{{ variable.kept ? t('lb10.editor.kept') : t('lb10.editor.missing') }}</span>
        </li>
        <li
          v-for="name in strangers"
          :key="`unknown-${name}`"
          class="lb10-chip lb10-chip--bad"
          data-unknown="true"
        >
          <LbIcon
            name="error"
            :size="12"
            tone="mono"
          />
          <span>{{ braced(name) }}</span>
          <span>{{ t('lb10.editor.notOfPack') }}</span>
        </li>
      </ul>
    </div>
    <p
      v-if="target && unchanged"
      class="state"
      data-testid="prompt-unchanged"
    >
      <LbIcon
        name="info"
        :size="16"
        tone="mono"
      />
      <span>{{ t('lb10.editor.unchanged') }}</span>
    </p>
    <p
      v-else-if="target"
      class="state"
      data-testid="prompt-changed"
    >
      <LbIcon
        name="info"
        :size="16"
        tone="mono"
      />
      <span>{{ t('lb10.editor.changed') }} {{ changeText }}.</span>
    </p>
    <div
      v-if="issues.length > 0"
      :id="`${id}-checks`"
      class="lb10-panel checks"
      data-testid="prompt-checks"
    >
      <h3>{{ t('lb10.editor.checks.title') }}</h3>
      <ul class="list">
        <li
          v-for="issue in issues"
          :key="issue.code"
          :data-code="issue.code"
        >
          <LbIcon
            name="warning"
            :size="14"
            tone="mono"
          />
          <span>{{ issueText(issue) }}</span>
        </li>
      </ul>
    </div>
    <div
      v-if="refused"
      :id="`${id}-refused`"
      class="lb10-panel checks"
      role="alert"
      data-testid="prompt-refused"
    >
      <h3>{{ t('lb10.editor.refused.title') }}</h3>
      <p>{{ t('lb10.editor.refused.intro') }}</p>
      <ul class="list">
        <li
          v-for="issue in refusedIssues"
          :key="issue.code"
          :data-code="issue.code"
        >
          <LbIcon
            name="error"
            :size="14"
            tone="mono"
          />
          <span>{{ issueText(issue) }}</span>
        </li>
        <li
          v-for="(problem, index) in unknownRefusals"
          :key="`other-${index}`"
          data-code="other"
        >
          <LbIcon
            name="error"
            :size="14"
            tone="mono"
          />
          <span>{{ t('lb10.editor.refused.other') }} <q lang="en">{{ problem.message }}</q></span>
        </li>
      </ul>
      <p class="lb10-hint">
        {{ t('lb10.editor.refused.free') }}
      </p>
    </div>
    <p class="lb10-hint">
      {{ t('lb10.editor.notKept') }}
    </p>
  </section>
</template>

<style scoped>
.field {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.field-label {
  font-size: 13px;
  font-weight: 700;
}
.control {
  width: 100%;
  min-width: 0;
  min-height: 12rem;
  padding: 8px 10px;
  font: 400 12.5px/1.55 var(--lb-font-mono);
  color: var(--lb-ink);
  resize: vertical;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}
.control:focus-visible {
  outline: 2px solid var(--lb-signal);
  outline-offset: 2px;
}
.control[aria-invalid="true"] {
  border-width: 2px;
  border-style: dashed;
}
.control[readonly] {
  background: var(--lb-shade);
}
.under {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  align-items: center;
  justify-content: space-between;
}
.count {
  font-size: 12.5px;
  color: var(--lb-graphite);
}
.count--over {
  font-weight: 700;
  color: var(--lb-ink);
}
.variables {
  display: grid;
  gap: 6px;
}
.state {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  font-size: 13.5px;
}
.state :deep(svg) {
  flex: none;
  margin-top: 2px;
}
.checks {
  border-width: 1.5px;
  border-style: dashed;
  border-color: var(--lb-ink);
}
.list {
  display: grid;
  gap: 6px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.list li {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  font-size: 13.5px;
}
.list li :deep(svg) {
  flex: none;
  margin-top: 3px;
}
</style>
