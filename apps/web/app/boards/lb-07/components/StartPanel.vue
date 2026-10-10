<script setup lang="ts">
// <StartPanel>: "Test the shop". The visitor picks one of the curated test runs (a goal from the golden set
// with the bugs it switches on and the verdict a correct run comes to) and either replays its recording,
// which is free, or runs it live, which uses one of the visitor's two runs a day and needs the quick check
// that they are a person. Below, a fold-out makes a run of their own: the six bugs as switches and a goal
// in plain words, checked here by the service's own rule (3 to 300 characters of plain text) before
// anything is sent. A curated goal is shown as the English text the agent reads, marked as English.
import { LB07_BUG_IDS } from '@lb/contracts'
import type { Lb07BugId } from '@lb/contracts'
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { LB07_SAMPLES } from '#shared/data/samples/lb07'
import type { Lb07SampleId } from '#shared/data/samples/lb07'
import { goalProblem, MAX_GOAL_LENGTH, normalizeGoal } from '../goal'
import { useLb07Words } from '../words'

const props = defineProps<{
  /** The IDs of the samples that have a recording, or undefined while that is not known yet. */
  recorded: readonly string[] | undefined
  /** Whether a run is being started or followed, so nothing new can start. */
  busy: boolean
  /** Whether this copy of the site can run tests live and the visitor has a run left. */
  canRunLive: boolean
  /** Whether the visitor's runs for today are used. */
  allowanceUsedUp: boolean
  /** Whether this copy of the site has no back end at all. */
  unavailable: boolean
}>()

const emit = defineEmits<{
  replay: [id: Lb07SampleId]
  live: [id: Lb07SampleId]
  own: [goal: string, bugs: Lb07BugId[]]
}>()

const { t } = useI18n()
const words = useLb07Words()
const id = useId()

const selected = ref<Lb07SampleId>(LB07_SAMPLES[0].id)
const bugs = ref<Lb07BugId[]>([])
const goal = ref('')
// The goal's problems are said once the visitor has written something, not while the field is still empty.
const touched = ref(false)

const sample = computed(() => LB07_SAMPLES.find(item => item.id === selected.value) ?? LB07_SAMPLES[0])
const hasRecording = computed(() => props.recorded?.includes(selected.value) === true)
const problem = computed(() => goalProblem(goal.value))
const shownProblem = computed(() => (touched.value ? problem.value : undefined))
const problemText = computed(() => {
  switch (shownProblem.value) {
    case 'tooShort': return t('lb07.start.goalTooShort')
    case 'tooLong': return t('lb07.start.goalTooLong', { max: MAX_GOAL_LENGTH })
    case 'control': return t('lb07.start.goalControl')
    default: return undefined
  }
})

/** Starts the run the visitor describes, if its goal is one the service takes. */
function startOwn(): void {
  touched.value = true
  if (problem.value === undefined && props.canRunLive && !props.busy) emit('own', normalizeGoal(goal.value), [...bugs.value])
}
</script>

<template>
  <section
    class="lb7-section"
    :aria-labelledby="`${id}-title`"
    data-testid="start-panel"
  >
    <h2 :id="`${id}-title`">
      {{ t('lb07.start.title') }}
    </h2>
    <fieldset class="choices">
      <legend class="lb7-label">
        {{ t('lb07.start.samplesLegend') }}
      </legend>
      <label
        v-for="item in LB07_SAMPLES"
        :key="item.id"
        class="choice"
        :data-testid="`sample-${item.id}`"
      >
        <input
          v-model="selected"
          type="radio"
          :name="`${id}-sample`"
          :value="item.id"
        >
        <span class="text">
          <strong>{{ t(`lb07.samples.${item.id}.title`) }}</strong>
          <span class="lb7-hint">{{ t(`lb07.samples.${item.id}.note`) }}</span>
        </span>
      </label>
    </fieldset>
    <div
      class="chosen"
      data-testid="sample-details"
    >
      <p class="lb7-label">
        {{ t('lb07.start.goal') }}
      </p>
      <blockquote
        class="lb7-quote"
        lang="en"
        data-testid="sample-goal"
      >
        {{ sample.goal }}
      </blockquote>
      <p class="lb7-label">
        {{ t('lb07.start.bugsOn') }}
      </p>
      <ul
        v-if="sample.bugs.length > 0"
        class="lb7-chips"
      >
        <li
          v-for="bug in sample.bugs"
          :key="bug"
          class="lb7-chip"
        >
          {{ words.bugTitle(bug) }}
        </li>
      </ul>
      <p
        v-else
        class="lb7-hint"
      >
        {{ t('lb07.start.noBugs') }}
      </p>
      <p class="expected">
        <span class="lb7-label">{{ t('lb07.start.expected') }}</span>
        <strong>{{ words.verdictWord(sample.verdict) }}</strong>
      </p>
    </div>
    <p
      v-if="recorded !== undefined && !hasRecording"
      class="lb7-hint"
      data-testid="no-recording"
    >
      {{ t('lb07.start.noRecording') }}
    </p>
    <div class="lb7-row">
      <button
        type="button"
        class="lb7-button"
        :disabled="busy || !hasRecording"
        data-testid="replay-sample"
        @click="emit('replay', selected)"
      >
        {{ t('lb07.start.replay') }}
      </button>
      <button
        type="button"
        class="lb7-button lb7-button--primary"
        :disabled="busy || !canRunLive"
        data-testid="live-sample"
        @click="emit('live', selected)"
      >
        {{ t('lb07.start.live') }}
      </button>
    </div>
    <p class="lb7-hint">
      {{ t('lb07.start.liveCost') }}
    </p>
    <p
      v-if="unavailable"
      class="lb7-hint"
      data-testid="no-live"
    >
      {{ t('lb07.start.noLive') }}
    </p>
    <p
      v-else-if="allowanceUsedUp"
      class="lb7-hint"
      data-testid="allowance-used"
    >
      {{ t('lb07.start.allowanceUsed') }}
    </p>
    <details
      class="own"
      data-testid="own-details"
    >
      <summary>{{ t('lb07.start.ownTitle') }}</summary>
      <form
        class="form"
        novalidate
        @submit.prevent="startOwn"
      >
        <p class="lb7-hint">
          {{ t('lb07.start.ownHint') }}
        </p>
        <fieldset class="choices">
          <legend class="lb7-label">
            {{ t('lb07.start.bugsLegend') }}
          </legend>
          <label
            v-for="bug in LB07_BUG_IDS"
            :key="bug"
            class="choice"
            :data-testid="`bug-${bug}`"
          >
            <input
              v-model="bugs"
              type="checkbox"
              :value="bug"
            >
            <span class="text">
              <strong>{{ words.bugTitle(bug) }}</strong>
              <span class="lb7-hint">{{ words.bugSummary(bug) }}</span>
            </span>
          </label>
        </fieldset>
        <p class="lb7-hint">
          {{ t('lb07.start.bugsHint') }}
        </p>
        <div class="lb7-field">
          <label :for="`${id}-goal`">{{ t('lb07.start.goalField') }}</label>
          <textarea
            :id="`${id}-goal`"
            v-model="goal"
            class="lb7-control"
            rows="3"
            :maxlength="MAX_GOAL_LENGTH"
            autocomplete="off"
            spellcheck="true"
            :aria-invalid="shownProblem !== undefined"
            :aria-describedby="`${id}-goal-hint ${id}-goal-count`"
            data-testid="own-goal"
            @blur="touched = goal !== ''"
            @keydown.enter.exact.prevent="startOwn"
          />
          <p
            :id="`${id}-goal-hint`"
            class="lb7-hint"
            :data-testid="problemText ? 'goal-problem' : 'goal-hint'"
          >
            {{ problemText ?? t('lb07.start.goalHint', { max: MAX_GOAL_LENGTH }) }}
          </p>
          <p
            :id="`${id}-goal-count`"
            class="lb7-hint lb7-nums"
            data-testid="goal-count"
          >
            {{ t('lb07.start.goalCount', { count: goal.length, max: MAX_GOAL_LENGTH }) }}
          </p>
        </div>
        <div class="lb7-row">
          <button
            type="submit"
            class="lb7-button lb7-button--primary"
            :disabled="busy || !canRunLive || problem !== undefined"
            data-testid="own-submit"
          >
            {{ t('lb07.start.startOwn') }}
          </button>
        </div>
      </form>
    </details>
  </section>
</template>

<style scoped>
.choices {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 230px), 1fr));
  gap: 8px;
  padding: 0;
  margin: 0;
  border: 0;
}
.choices legend {
  margin-bottom: 6px;
}
.choice {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  cursor: pointer;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-rule);
  border-radius: 4px;
}
.choice:has(input:checked) {
  border-color: var(--lb-ink);
}
.choice:has(input:focus-visible) {
  outline: 2px solid var(--lb-signal);
  outline-offset: 2px;
}
.choice input {
  flex: none;
  margin-top: 3px;
}
.text {
  display: grid;
  gap: 2px;
  justify-items: start;
  min-width: 0;
}
.chosen {
  display: grid;
  gap: 6px;
  padding: 12px 14px;
  background: var(--lb-sheet);
  border: 1px solid var(--lb-rule);
}
.expected {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
}
.own {
  padding-top: 4px;
}
.own summary {
  font-weight: 700;
  cursor: pointer;
}
.own summary:focus-visible {
  outline: 2px solid var(--lb-signal);
  outline-offset: 2px;
}
.form {
  display: grid;
  gap: 12px;
  padding-top: 10px;
}
.form .lb7-field {
  max-width: 560px;
}
</style>
