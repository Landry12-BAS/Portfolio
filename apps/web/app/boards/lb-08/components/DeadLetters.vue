<script setup lang="ts">
// <DeadLetters>: what is left when a step runs out of attempts, and the one-click way to recover.
// A step that used all three attempts is put in the dead-letter queue with the error that ended it.
// A replay runs the workflow again as a new run of the same version with the same test order: what
// the earlier runs already sent is recognised by its key and not sent twice, and the step that
// failed gets another go. The replay can be of one dead letter or of the whole run. Either counts as
// one of the day's runs and needs the check, which is why the buttons say what they cost.
import { LbIcon } from '@lb/icons'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { wordsFrom } from '../graph/words'
import { errorWords, stepName } from '../run/narrate'
import { useLb08Store } from '../store'

defineProps<{
  /** The Brief reading leaves out the service's own error codes. */
  brief: boolean
}>()

const { t, te } = useI18n()
const store = useLb08Store()
const { currentRun, chainLetters, canReplay, busy, runMode, runGraph, runOver } = storeToRefs(store)

const words = wordsFrom((key, params) => t(key, params), key => te(key))
const working = computed(() => busy.value === 'starting')
const why = computed(() => (runMode.value === 'replay' ? t('lb08.run.blockedReplay') : t('lb08.replayRun.blocked')))

/** A step's name. */
function nameOf(nodeId: string): string {
  return stepName(runGraph.value, nodeId)
}
</script>

<template>
  <section
    v-if="currentRun"
    class="lb8-section"
    :aria-label="t('lb08.deadLetters.title')"
    data-testid="dead-letters"
  >
    <h2>{{ t('lb08.deadLetters.title') }}</h2>
    <p class="lb8-hint">
      {{ t('lb08.deadLetters.text') }}
    </p>
    <p
      v-if="chainLetters.length === 0"
      class="lb8-hint"
      data-testid="dead-empty"
    >
      {{ t('lb08.deadLetters.empty') }}
    </p>
    <div
      v-else
      class="lb8-table-wrap"
      role="region"
      tabindex="0"
      :aria-label="t('lb08.deadLetters.title')"
    >
      <table class="lb8-table">
        <caption class="lb-sr-only">
          {{ t('lb08.deadLetters.title') }}
        </caption>
        <thead>
          <tr>
            <th scope="col">
              {{ t('lb08.deadLetters.columns.step') }}
            </th>
            <th scope="col">
              {{ t('lb08.deadLetters.columns.attempts') }}
            </th>
            <th scope="col">
              {{ t('lb08.deadLetters.columns.error') }}
            </th>
            <th scope="col">
              {{ t('lb08.deadLetters.columns.replay') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="letter in chainLetters"
            :key="letter.id"
            data-testid="dead-letter"
            :data-step="letter.nodeId"
          >
            <th scope="row">
              <span class="who">
                <LbIcon
                  name="incident"
                  :size="16"
                  tone="mono"
                />
                {{ nameOf(letter.nodeId) }}
              </span>
            </th>
            <td class="lb8-nums">
              {{ letter.attempts }}
            </td>
            <td>
              {{ errorWords(words, letter.error.code) }}
              <span
                v-if="!brief"
                class="lb8-mono type"
                lang="en"
              >{{ letter.error.code }}</span>
            </td>
            <td>
              <span
                v-if="letter.replayedRunId"
                class="lb8-chip"
                data-testid="dead-replayed"
              >{{ t('lb08.deadLetters.replayed') }}</span>
              <button
                v-else
                type="button"
                class="lb8-button"
                :disabled="!canReplay || working"
                :aria-label="t('lb08.deadLetters.replayLabel', { step: nameOf(letter.nodeId) })"
                data-testid="dead-replay"
                @click="store.replayRun(letter.id)"
              >
                {{ working ? t('lb08.deadLetters.working') : t('lb08.deadLetters.replay') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="lb8-panel">
      <h3>{{ t('lb08.replayRun.title') }}</h3>
      <p>{{ t('lb08.replayRun.text') }}</p>
      <div class="lb8-row">
        <button
          type="button"
          class="lb8-button"
          :disabled="!canReplay || working || !runOver"
          :aria-describedby="canReplay ? undefined : 'lb08-replay-why'"
          data-testid="replay-run"
          @click="store.replayRun()"
        >
          {{ working ? t('lb08.deadLetters.working') : t('lb08.replayRun.button') }}
        </button>
      </div>
      <p
        v-if="!canReplay"
        id="lb08-replay-why"
        class="lb8-hint"
      >
        {{ why }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.who {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-weight: 600;
}

.type {
  display: block;
  font-size: 11px;
  color: var(--lb-graphite);
}
</style>
