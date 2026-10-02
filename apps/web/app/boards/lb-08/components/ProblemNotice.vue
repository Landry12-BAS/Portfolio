<script setup lang="ts">
// <ProblemNotice>: what the board says when a call did not work. Most failures are the kit's
// notices (the day's limit, the system down, the check). Four are this board's own, because their
// cause is something only this board has: a described process the checks refused (with every
// problem found in it), the model being unavailable for the description, the visitor already keeping
// as many workflows as are allowed, and a request that no longer fits the state of a run. The words
// come from the locale files by the failure's code; the service's own messages are English and only
// appear, marked as such, in the Technical reading.
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { ApiProblem } from '~/board-kit/problem'
import { useSessionStore } from '~/stores/session'

const props = defineProps<{
  problem: ApiProblem
  /** The Brief reading leaves out the validator's codes, places and English messages. */
  brief: boolean
}>()

const { t, te } = useI18n()
const { state } = storeToRefs(useSessionStore())

const own = computed<'refused' | 'unavailable' | 'tooMany' | 'conflict' | undefined>(() => {
  const { code, kind, problems } = props.problem
  if (code === 'workflow_rejected' && problems.length > 0) return 'refused'
  if (code === 'generation_unavailable') return 'unavailable'
  if (code === 'workflow_limit') return 'tooMany'
  if (kind === 'conflict') return 'conflict'
  return undefined
})
const conflictText = computed(() => {
  const key = `lb08.conflicts.${props.problem.code}`
  return te(key) ? t(key) : t('lb08.conflicts.other')
})

/** A validator problem said in the visitor's language, by its code. */
function codeWords(code: string): string {
  const key = `lb08.codes.${code}`
  return te(key) ? t(key) : t('lb08.codes.invalid_value')
}
</script>

<template>
  <div
    v-if="own === 'refused'"
    class="lb8-panel refusal"
    role="alert"
    data-testid="refusal"
  >
    <h3>{{ t('lb08.refused.title') }}</h3>
    <p>{{ t('lb08.refused.text') }}</p>
    <ul class="list">
      <li
        v-for="(item, index) in problem.problems"
        :key="index"
        data-testid="refusal-problem"
        :data-code="item.code"
      >
        {{ codeWords(item.code) }}
        <span
          v-if="!brief"
          class="lb8-mono technical"
          lang="en"
        >{{ item.code }} · {{ item.path }} · {{ item.message }}</span>
      </li>
    </ul>
  </div>
  <div
    v-else-if="own === 'unavailable'"
    class="lb8-panel"
    role="status"
    data-testid="generation-unavailable"
  >
    <h3>{{ t('lb08.refused.unavailableTitle') }}</h3>
    <p>{{ t('lb08.refused.unavailableText') }}</p>
  </div>
  <div
    v-else-if="own === 'tooMany'"
    class="lb8-panel"
    role="alert"
    data-testid="too-many-workflows"
  >
    <p>{{ t('lb08.refused.tooMany') }}</p>
  </div>
  <div
    v-else-if="own === 'conflict'"
    class="lb8-panel"
    role="alert"
    data-testid="conflict"
  >
    <p>{{ conflictText }}</p>
  </div>
  <BoardNotice
    v-else
    :kind="problem.kind"
    :resets-at="problem.resetsAt ?? state?.resetsAt"
    :detail="problem.kind === 'rejected' ? problem.message : undefined"
  />
</template>

<style scoped>
.refusal {
  border: 2px solid var(--lb-ink);
}

.list {
  display: grid;
  gap: 8px;
  padding: 0 0 0 18px;
  margin: 0;
}

.technical {
  display: block;
  font-size: 11.5px;
  color: var(--lb-graphite);
  overflow-wrap: anywhere;
}
</style>
