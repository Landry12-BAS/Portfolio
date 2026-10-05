<script setup lang="ts">
// <ProblemNotice>: what the board says when a call did not work. Most failures are the kit's notices (the system down,
// the check, the network). Some are this board's own, because their cause is something only this lab has: it is full
// (try in a minute, nothing was counted), it has no gateway to the models, the visitor's run of the day is used (with
// when it starts again) or still going, the providers chosen are not offered, the prompt it was asked for does not
// exist, and a run that is gone. Which failures those are is decided by their code (problems.ts), not by the kit's
// kind. The words come from the locale files, never from the service. A refused prompt is not here: the editor lists
// its problems beside the prompt.
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatMoment } from '~/board-kit/format'
import type { ApiProblem } from '~/board-kit/problem'
import { useSessionStore } from '~/stores/session'
import { ownNoticeOf } from '../problems'

const props = defineProps<{
  problem: ApiProblem
}>()

const { t, locale } = useI18n()
const { state } = storeToRefs(useSessionStore())
const own = computed(() => ownNoticeOf(props.problem))
const resetsAt = computed(() => props.problem.resetsAt ?? state.value?.resetsAt)
</script>

<template>
  <div
    v-if="own === 'gone'"
    class="lb10-panel"
    role="alert"
    data-testid="own-notice"
    data-notice="gone"
  >
    <p>{{ t('lb10.notices.gone') }}</p>
  </div>
  <div
    v-else-if="own"
    class="lb10-panel notice"
    :role="own === 'daily_limit' || own === 'unavailable' ? 'status' : 'alert'"
    data-testid="own-notice"
    :data-notice="own"
  >
    <h3>{{ t(`lb10.notices.${own}.title`) }}</h3>
    <p>{{ t(`lb10.notices.${own}.text`) }}</p>
    <p v-if="own === 'daily_limit' && resetsAt">
      {{ t('lb10.notices.daily_limit.resets', { time: formatMoment(resetsAt, locale) }) }}
    </p>
  </div>
  <BoardNotice
    v-else
    :kind="problem.kind"
    :resets-at="problem.resetsAt ?? state?.resetsAt"
  />
</template>

<style scoped>
.notice {
  border-width: 1.5px;
  border-color: var(--lb-ink);
}
</style>
