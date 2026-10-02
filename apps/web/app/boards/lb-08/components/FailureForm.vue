<script setup lang="ts">
// <FailureForm>: "make a step fail". For each step that calls a connector, the visitor picks how
// many times that connector fails before it works, up to the most the service allows. A step gets
// three attempts with a growing wait between them, so one or two failures are retried and then
// work, and three or more use every attempt and send the step to the dead-letter queue. The form
// says which of the two a choice leads to. It only asks; the service makes the connector fail.
import { RUN_LIMITS } from '@lb/contracts'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { outlineOf } from '../graph/outline'
import { useLb08Store } from '../store'

const { t } = useI18n()
const store = useLb08Store()
const { draft, failures, canEdit } = storeToRefs(store)

/** The numbers of failures to offer: none, then one up to the most allowed. */
const TIMES = Array.from({ length: RUN_LIMITS.maxInjectedFailures + 1 }, (_, count) => count)

const actions = computed(() => (draft.value ? outlineOf(draft.value).filter(item => item.node.type === 'action') : []))

/** The words for a number of failures. */
function timesWords(count: number): string {
  if (count === 0) return t('lb08.run.failNone')
  return count === 1 ? t('lb08.run.failOnce') : t('lb08.run.failTimes', { count })
}

/** How many times the step was asked to fail. */
function timesOf(nodeId: string): number {
  return failures.value[nodeId] ?? 0
}

/** What a choice leads to, once it is not nothing. */
function outcomeOf(nodeId: string): string | undefined {
  const count = timesOf(nodeId)
  if (count === 0) return undefined
  return count < RUN_LIMITS.maxAttempts ? t('lb08.run.failRetry') : t('lb08.run.failDead')
}

/** Takes the number the visitor chose for a step. */
function choose(nodeId: string, event: Event): void {
  const target = event.target
  if (target instanceof HTMLSelectElement) store.setFailures(nodeId, Number(target.value))
}
</script>

<template>
  <fieldset
    class="fail"
    data-testid="failures"
  >
    <legend>{{ t('lb08.run.failTitle') }}</legend>
    <p class="lb8-hint">
      {{ t('lb08.run.failHelp') }}
    </p>
    <p
      v-if="actions.length === 0"
      class="lb8-hint"
    >
      {{ t('lb08.run.failNoActions') }}
    </p>
    <ul class="list">
      <li
        v-for="item in actions"
        :key="item.node.id"
        class="item"
        data-testid="failure"
        :data-step="item.node.id"
      >
        <label :for="`lb08-fail-${item.node.id}`">{{ t('lb08.run.failLabel', { step: item.node.label || item.node.id }) }}</label>
        <select
          :id="`lb08-fail-${item.node.id}`"
          class="lb8-control pick"
          :value="timesOf(item.node.id)"
          :disabled="!canEdit"
          :aria-describedby="outcomeOf(item.node.id) ? `lb08-fail-${item.node.id}-outcome` : undefined"
          @change="choose(item.node.id, $event)"
        >
          <option
            v-for="count in TIMES"
            :key="count"
            :value="count"
          >
            {{ timesWords(count) }}
          </option>
        </select>
        <span
          v-if="outcomeOf(item.node.id)"
          :id="`lb08-fail-${item.node.id}-outcome`"
          class="lb8-hint"
        >{{ outcomeOf(item.node.id) }}</span>
      </li>
    </ul>
  </fieldset>
</template>

<style scoped>
.fail {
  display: grid;
  gap: 10px;
  min-width: 0;
  padding: 10px 12px 12px;
  margin: 0;
  border: 1px solid var(--lb-rule);
}

.fail > legend {
  padding: 0 6px;
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.list {
  display: grid;
  gap: 8px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.item {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  align-items: center;
}

.item > label {
  flex: 1 1 200px;
  font-size: 13.5px;
  font-weight: 600;
}

.pick {
  width: auto;
  min-width: 150px;
  padding-block: 4px;
}
</style>
