<script setup lang="ts">
// <ProviderChoice>: "3. Where it runs". The providers a visitor's prompt may go to, Groq and Workers AI, each with what
// it does with what it is sent and the pinned model the prompt's class runs on there, and why OpenRouter is not one of
// them. Then what this run will cost in model calls (ten a provider for the visitor's prompt, and ten more a provider
// for production's if its results are not cached yet; an unchanged prompt runs once), the rule that gives back a run
// the service fails, and the button that runs it live, which uses the visitor's run of the day.
import { storeToRefs } from 'pinia'
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLb10Store } from '../store'
import { useLb10Words } from '../words'

const props = defineProps<{
  /** Whether this copy of the site can run evals live and the visitor has a run left. */
  canRunLive: boolean
  /** Whether the visitor's run of the day is used. */
  allowanceUsedUp: boolean
  /** Whether this copy of the site has no back end at all. */
  unavailable: boolean
}>()

const emit = defineEmits<{ run: [] }>()

const { t, te } = useI18n()
const words = useLb10Words()
const store = useLb10Store()
const { target, providers, limits, unchanged, issues, busy, phase, runMode, canRun } = storeToRefs(store)
const id = useId()

const offered = computed(() => target.value?.providers ?? [])
const cases = computed(() => limits.value?.cases_per_run ?? 0)
const mine = computed(() => cases.value * providers.value.length)
const starting = computed(() => runMode.value === 'live' && phase.value === 'starting')
const blocked = computed(() => issues.value.length > 0)

/** Tells whether a provider is chosen. */
function isChosen(provider: string): boolean {
  return providers.value.includes(provider)
}

/** Chooses or drops a provider as its box is ticked. */
function onToggle(provider: string, event: Event): void {
  store.setProvider(provider, (event.target as HTMLInputElement).checked)
}

/** Starts the run, when everything it needs is there. */
function start(): void {
  if (props.canRunLive && store.ready) emit('run')
}
</script>

<template>
  <section
    class="lb10-section"
    :aria-labelledby="`${id}-title`"
    data-testid="provider-choice"
  >
    <h2 :id="`${id}-title`">
      {{ t('lb10.providers.title') }}
    </h2>
    <fieldset
      v-if="offered.length > 0"
      class="choices"
    >
      <legend class="lb10-label">
        {{ t('lb10.providers.legend') }}
      </legend>
      <label
        v-for="provider in offered"
        :key="provider.id"
        class="choice"
        :data-testid="`provider-${provider.id}`"
      >
        <input
          type="checkbox"
          :checked="isChosen(provider.id)"
          :disabled="busy"
          @change="onToggle(provider.id, $event)"
        >
        <span class="text">
          <strong>{{ words.providerName(provider.id, provider.name) }}</strong>
          <span
            v-if="te(`lb10.providers.notes.${provider.id}`)"
            class="lb10-hint"
          >{{ t(`lb10.providers.notes.${provider.id}`) }}</span>
          <span
            v-else
            class="lb10-hint"
          >{{ t('lb10.providers.otherNote') }} <q lang="en">{{ provider.note }}</q></span>
          <span class="lb10-hint lb10-mono">{{ t('lb10.providers.alias', { alias: provider.alias }) }}</span>
        </span>
      </label>
    </fieldset>
    <p class="lb10-hint">
      {{ t('lb10.providers.whyNotOpenRouter') }}
    </p>
    <p
      v-if="providers.length === 0"
      class="lb10-hint"
      role="status"
      data-testid="pick-one"
    >
      {{ t('lb10.providers.pickOne') }}
    </p>
    <p
      v-else-if="unchanged"
      data-testid="run-cost"
    >
      {{ t('lb10.providers.costUnchanged', { calls: words.number(mine) }) }}
    </p>
    <p
      v-else
      data-testid="run-cost"
    >
      {{ t('lb10.providers.cost', { mine: words.number(mine), baseline: words.number(mine), max: words.number(mine * 2) }) }}
    </p>
    <p class="lb10-hint">
      {{ t('lb10.providers.givenBack') }}
    </p>
    <div class="lb10-row">
      <button
        type="button"
        class="lb10-button lb10-button--primary"
        :disabled="busy || !canRunLive || !store.ready"
        data-testid="run-live"
        @click="start"
      >
        {{ starting ? t('lb10.providers.starting') : t('lb10.providers.run') }}
      </button>
    </div>
    <p
      v-if="unavailable"
      class="lb10-hint"
      data-testid="no-live"
    >
      {{ t('lb10.providers.noLive') }}
    </p>
    <p
      v-else-if="target && !canRun"
      class="lb10-hint"
      data-testid="no-gateway"
    >
      {{ t('lb10.providers.noGateway') }}
    </p>
    <p
      v-else-if="allowanceUsedUp"
      class="lb10-hint"
      data-testid="allowance-used"
    >
      {{ t('lb10.providers.usedUp') }}
    </p>
    <p
      v-else-if="blocked"
      class="lb10-hint"
      data-testid="fix-first"
    >
      {{ t('lb10.providers.fixFirst') }}
    </p>
  </section>
</template>

<style scoped>
.choices {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 250px), 1fr));
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
  box-shadow: inset 0 0 0 1px var(--lb-ink);
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
  gap: 3px;
  min-width: 0;
}
</style>
