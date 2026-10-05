<script setup lang="ts">
// <TargetPicker>: "1. The prompt to measure". The five prompts the lab measures, one for each pack the other systems
// export, as radio cards with the system's part number; and for the chosen one, what it is graded on and what this
// lab cannot grade, in the board's words, then its details: production's prompt, what each case sends after it, the
// variables an edit must keep, the tools it may call, and the fixed ten cases (TargetCases). Everything a prompt or a
// case says is data, shown as text and never as markup.
import { storeToRefs } from 'pinia'
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLb10Store } from '../store'
import { useLb10Words } from '../words'
import TargetCases from './TargetCases.vue'

defineProps<{
  /** The Brief reading leaves out the template, the alias, the source and the version. */
  brief: boolean
  /** Whether a run is being started or followed, so the prompt cannot be changed under it. */
  busy: boolean
}>()

const { t } = useI18n()
const words = useLb10Words()
const store = useLb10Store()
const { targets, targetsStatus, target, pack } = storeToRefs(store)
const id = useId()

const chosen = computed({
  get: () => pack.value,
  set: (name: string) => store.chooseTarget(name),
})
const variableNames = computed(() => (target.value?.variables ?? []).map(name => `{{${name}}}`))
const knows = computed(() => (target.value ? words.knowsPack(target.value.pack) : false))
</script>

<template>
  <section
    id="lb10-target"
    class="lb10-section"
    :aria-labelledby="`${id}-title`"
    data-testid="target-picker"
  >
    <h2 :id="`${id}-title`">
      {{ t('lb10.targets.title') }}
    </h2>
    <p
      v-if="targetsStatus === 'loading' && !targets"
      class="lb10-hint"
      role="status"
    >
      {{ t('lb10.targets.loading') }}
    </p>
    <div
      v-else-if="targetsStatus === 'failed' && !targets"
      class="lb10-panel"
      role="alert"
      data-testid="targets-failed"
    >
      <p>{{ t('lb10.targets.failed') }}</p>
      <div class="lb10-row">
        <button
          type="button"
          class="lb10-button"
          @click="store.loadTargets()"
        >
          {{ t('lb10.targets.retry') }}
        </button>
      </div>
    </div>
    <template v-if="targets">
      <fieldset class="choices">
        <legend class="lb10-label">
          {{ t('lb10.targets.legend') }}
        </legend>
        <label
          v-for="item in targets.targets"
          :key="item.pack"
          class="choice"
          :data-testid="`target-${item.pack}`"
        >
          <input
            v-model="chosen"
            type="radio"
            :name="`${id}-target`"
            :value="item.pack"
            :disabled="busy"
          >
          <span class="text">
            <strong>{{ words.packTitle(item.pack, item.name) }}</strong>
          </span>
        </label>
      </fieldset>
      <div
        v-if="target"
        class="lb10-panel"
        data-testid="target-details"
        :data-pack="target.pack"
      >
        <h3>{{ words.packTitle(target.pack, target.name) }}</h3>
        <dl class="grading">
          <template v-if="knows">
            <div>
              <dt class="lb10-label">
                {{ t('lb10.targets.grades') }}
              </dt>
              <dd data-testid="target-grades">
                {{ t(`lb10.targets.packs.${target.pack}.grades`) }}
              </dd>
            </div>
            <div>
              <dt class="lb10-label">
                {{ t('lb10.targets.cannot') }}
              </dt>
              <dd data-testid="target-cannot">
                {{ t(`lb10.targets.packs.${target.pack}.cannot`) }}
              </dd>
            </div>
          </template>
          <div v-else>
            <dt class="lb10-label">
              {{ t('lb10.targets.unknownPack') }}
            </dt>
            <dd lang="en">
              {{ target.description }}
            </dd>
          </div>
          <div>
            <dt class="lb10-label">
              {{ t('lb10.targets.answer') }}
            </dt>
            <dd>{{ t(`lb10.targets.outputs.${target.output}`) }}</dd>
          </div>
          <div>
            <dt class="lb10-label">
              {{ t('lb10.targets.variables') }}
            </dt>
            <dd>
              <ul
                v-if="variableNames.length > 0"
                class="lb10-chips"
                data-testid="target-variables"
              >
                <li
                  v-for="name in variableNames"
                  :key="name"
                  class="lb10-chip"
                >
                  {{ name }}
                </li>
              </ul>
              <span v-else>{{ t('lb10.targets.noVariables') }}</span>
            </dd>
          </div>
          <div v-if="target.tool_names.length > 0">
            <dt class="lb10-label">
              {{ t('lb10.targets.tools') }}
            </dt>
            <dd>
              <ul
                class="lb10-chips"
                data-testid="target-tools"
              >
                <li
                  v-for="name in target.tool_names"
                  :key="name"
                  class="lb10-chip"
                >
                  {{ name }}
                </li>
              </ul>
            </dd>
          </div>
          <template v-if="!brief">
            <div>
              <dt class="lb10-label">
                {{ t('lb10.targets.alias') }}
              </dt>
              <dd class="lb10-mono">
                {{ target.alias }}
              </dd>
            </div>
            <div>
              <dt class="lb10-label">
                {{ t('lb10.targets.source') }}
              </dt>
              <dd class="lb10-mono">
                {{ target.source }}
              </dd>
            </div>
            <div>
              <dt class="lb10-label">
                {{ t('lb10.targets.version') }}
              </dt>
              <dd class="lb10-mono">
                {{ target.version }}
              </dd>
            </div>
          </template>
        </dl>
        <details
          class="lb10-details"
          data-testid="production-prompt"
        >
          <summary>{{ t('lb10.targets.production') }}</summary>
          <p class="lb10-hint">
            {{ t('lb10.targets.productionNote') }}
          </p>
          <pre
            class="lb10-text"
            lang="en"
            tabindex="0"
            :aria-label="t('lb10.targets.production')"
          >{{ target.system_prompt }}</pre>
          <template v-if="!brief">
            <p class="lb10-label">
              {{ t('lb10.targets.userTemplate') }}
            </p>
            <pre
              class="lb10-text"
              lang="en"
              tabindex="0"
              :aria-label="t('lb10.targets.userTemplate')"
            >{{ target.user_template }}</pre>
          </template>
        </details>
        <TargetCases :target="target" />
      </div>
    </template>
  </section>
</template>

<style scoped>
.choices {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 190px), 1fr));
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
.choice:has(input:disabled) {
  cursor: not-allowed;
}
.choice input {
  flex: none;
  margin-top: 3px;
}
.text {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.grading {
  display: grid;
  gap: 10px;
  margin: 0;
}
.grading dd {
  margin: 2px 0 0;
}
</style>
