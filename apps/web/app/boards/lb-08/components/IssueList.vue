<script setup lang="ts">
// <IssueList>: every problem the validator found in the workflow being edited, in the visitor's
// language, each with a button that goes to the step or the connection it concerns. This is the
// summary; each problem is also written at its own step in the outline and at its own node on the
// canvas. The count is announced when it changes, so a visitor who cannot see the canvas learns that
// an edit broke the workflow. In the Technical reading each problem also shows the validator's
// stable code, its place in the graph and its own message.
import { LbIcon } from '@lb/icons'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { wordsFor } from '../graph/issues'
import type { LocatedIssue } from '../graph/issues'
import { useLb08Store } from '../store'

defineProps<{
  /** The Brief reading leaves out the validator's codes and its English messages. */
  brief: boolean
}>()

const emit = defineEmits<{ goTo: [] }>()

const { t, te } = useI18n()
const store = useLb08Store()
const { draft, issues, valid } = storeToRefs(store)

const all = computed(() => issues.value?.all ?? [])

/** The words for a field's name in a message. */
function labelOf(owner: string, name: string): string {
  const key = `lb08.fields.${owner}.${name}.label`
  return te(key) ? t(key) : name
}

/** Writes a problem as words. */
function words(item: LocatedIssue): string {
  if (!draft.value) return ''
  const found = wordsFor(draft.value, item, labelOf)
  return t(found.key, found.params)
}

/** Tells whether a problem has a step or a connection to go to. */
function hasPlace(item: LocatedIssue): boolean {
  return item.target.kind !== 'graph'
}

/** Picks the step or the connection a problem concerns. */
function goTo(item: LocatedIssue): void {
  if (item.target.kind === 'node') store.select({ kind: 'node', id: item.target.nodeId })
  else if (item.target.kind === 'edge') store.select({ kind: 'edge', index: item.target.index })
  emit('goTo')
}
</script>

<template>
  <section
    class="lb8-panel"
    :aria-label="t('lb08.editor.problemsTitle')"
    data-testid="issues"
  >
    <h3>{{ t('lb08.editor.problemsTitle') }}</h3>
    <p
      class="status"
      role="status"
      data-testid="validity"
    >
      <LbIcon
        :name="valid ? 'success' : 'warning'"
        :size="16"
        tone="mono"
      />
      <span v-if="valid">{{ t('lb08.editor.valid', { steps: draft?.nodes.length ?? 0, edges: draft?.edges.length ?? 0 }) }}</span>
      <span v-else>{{ t('lb08.editor.problems', { count: all.length }) }}</span>
    </p>
    <ul
      v-if="all.length > 0"
      class="list"
    >
      <li
        v-for="(item, index) in all"
        :key="index"
        class="item"
        data-testid="issue"
        :data-code="item.issue.code"
      >
        <p
          :id="`issue-${index}`"
          class="words"
        >
          {{ words(item) }}
        </p>
        <button
          v-if="hasPlace(item)"
          type="button"
          class="lb8-button lb8-button--quiet"
          :aria-describedby="`issue-${index}`"
          @click="goTo(item)"
        >
          {{ t('lb08.editor.goTo') }}
        </button>
        <p
          v-if="!brief"
          class="technical lb8-mono"
          lang="en"
        >
          {{ item.issue.code }} · {{ item.issue.path }} · {{ item.issue.message }}
        </p>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
}

.list {
  display: grid;
  gap: 8px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.item {
  display: grid;
  gap: 4px;
  justify-items: start;
  padding-left: 10px;
  border-left: 3px solid var(--lb-ink);
}

.words {
  font-size: 13.5px;
}

.technical {
  font-size: 11.5px;
  color: var(--lb-graphite);
  overflow-wrap: anywhere;
}
</style>
