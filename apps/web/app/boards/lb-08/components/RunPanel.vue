<script setup lang="ts">
// <RunPanel>: where a run is started. The visitor reads the test order the workflow's event
// carries, may make a step's connector fail on purpose, and presses Run. A run uses the saved
// version of the workflow, so a draft with changes is saved first (the button says so). The panel
// says why the button is off when it is: the workflow has problems, the test order does, today's
// runs are used up, or what is on the board is a recording. The sandbox notice sits here because it
// is here that the visitor decides to send something, and it says what "sent" means in this demo.
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useLb08Store } from '../store'

import FailureForm from './FailureForm.vue'
import OrderForm from './OrderForm.vue'

const emit = defineEmits<{
  /** The visitor asked for a run. */
  start: []
}>()

const { t } = useI18n()
const store = useLb08Store()
const { dirty, valid, busy, runMode, canStart, quota, orderIssues, runPhase, workflow } = storeToRefs(store)

const starting = computed(() => busy.value === 'starting')
const label = computed(() => {
  if (starting.value) return t('lb08.run.starting')
  return dirty.value ? t('lb08.run.startSave') : t('lb08.run.start')
})
/** Why the button is off, in words, or nothing when it is on. */
const blocked = computed(() => {
  if (runMode.value === 'replay') return t('lb08.run.blockedReplay')
  if (quota.value !== undefined && quota.value.remaining <= 0) return t('lb08.run.blockedRuns')
  if (!valid.value) return t('lb08.run.blockedInvalid')
  if (orderIssues.value.size > 0) return t('lb08.run.blockedOrder')
  return undefined
})
const followed = computed(() => runPhase.value === 'following')

/** Asks for the run. */
function start(): void {
  emit('start')
}
</script>

<template>
  <section
    v-if="workflow"
    id="lb08-run"
    class="lb8-section"
    :aria-label="t('lb08.run.title')"
    data-testid="run-panel"
  >
    <h2>{{ t('lb08.run.title') }}</h2>
    <p class="lb8-hint">
      {{ t('lb08.run.help') }}
    </p>

    <div
      class="lb8-panel sandbox"
      data-testid="sandbox"
    >
      <h3>{{ t('lb08.sandbox.title') }}</h3>
      <p>{{ t('lb08.sandbox.text') }}</p>
    </div>

    <OrderForm />
    <FailureForm />

    <div class="lb8-row">
      <button
        type="button"
        class="lb8-button lb8-button--primary"
        :disabled="!canStart || starting"
        :aria-describedby="blocked ? 'lb08-run-blocked' : 'lb08-run-cost'"
        data-testid="run"
        @click="start"
      >
        {{ label }}
      </button>
      <span
        v-if="followed"
        class="lb8-hint"
        role="status"
      >{{ t('lb08.status.working') }}</span>
    </div>
    <p
      v-if="blocked"
      id="lb08-run-blocked"
      class="lb8-hint"
      data-testid="run-blocked"
    >
      {{ blocked }}
    </p>
    <p
      id="lb08-run-cost"
      class="lb8-hint"
    >
      {{ t('lb08.run.cost') }}
    </p>
  </section>
</template>

<style scoped>
.sandbox > p {
  font-size: 13.5px;
}
</style>
