<script setup lang="ts">
// <ProblemNotice>: what the board says when a call did not work. Most failures are the kit's
// notices (the day's limit, the system down, the check). Five are this board's own, because their
// cause is something only this board has: the demo is running as many incidents as it can, the
// agents' models are out of reach, the incident could not be queued, the incident has ended already,
// and a proposal was answered already. Which failures those are is decided by their code
// (problems.ts), not by the kit's kind. The words come from the locale files, never from the service.
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ApiProblem } from '~/board-kit/problem'
import { useSessionStore } from '~/stores/session'
import { ownNoticeOf } from '../problems'

const props = defineProps<{
  problem: ApiProblem
}>()

const { t } = useI18n()
const { state } = storeToRefs(useSessionStore())
const own = computed(() => ownNoticeOf(props.problem))
</script>

<template>
  <div
    v-if="own === 'busy' || own === 'agents' || own === 'queue'"
    class="lb6-panel"
    role="alert"
    :data-testid="`notice-${own}`"
  >
    <h3>{{ t(`lb06.notices.${own}.title`) }}</h3>
    <p>{{ t(`lb06.notices.${own}.text`) }}</p>
  </div>
  <div
    v-else-if="own === 'ended' || own === 'settled'"
    class="lb6-panel"
    role="alert"
    :data-testid="`notice-${own}`"
  >
    <p>{{ t(`lb06.notices.${own}`) }}</p>
  </div>
  <BoardNotice
    v-else
    :kind="problem.kind"
    :resets-at="problem.resetsAt ?? state?.resetsAt"
    :detail="problem.kind === 'rejected' ? problem.message : undefined"
  />
</template>
