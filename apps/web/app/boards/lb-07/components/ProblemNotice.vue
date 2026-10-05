<script setup lang="ts">
// <ProblemNotice>: what the board says when a call did not work. Most failures are the kit's notices (the
// day's limit, the system down, the check). Four are this board's own, because their cause is something
// only this board has: the one browser is busy with other visitors' runs, a run could not be queued, the
// model is out of reach, and a run that is gone. Which failures those are is decided by their code
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
    v-if="own === 'busy' || own === 'queue' || own === 'model'"
    class="lb7-panel"
    role="alert"
    data-testid="own-notice"
    :data-notice="own"
  >
    <h3>{{ t(`lb07.notices.${own}.title`) }}</h3>
    <p>{{ t(`lb07.notices.${own}.text`) }}</p>
  </div>
  <div
    v-else-if="own === 'gone'"
    class="lb7-panel"
    role="alert"
    data-testid="own-notice"
    data-notice="gone"
  >
    <p>{{ t('lb07.notices.gone') }}</p>
  </div>
  <BoardNotice
    v-else
    :kind="problem.kind"
    :resets-at="problem.resetsAt ?? state?.resetsAt"
    :detail="problem.kind === 'rejected' ? problem.message : undefined"
  />
</template>
