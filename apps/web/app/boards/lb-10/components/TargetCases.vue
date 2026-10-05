<script setup lang="ts">
// <TargetCases>: the fixed ten cases a run of a target uses, drawn once for each version of its pack (the hard ones
// always in), so every visitor's run of that version is scored on the same cases and production's results can be
// cached. Each case shows its difficulty, its inputs as the text the model is given, what the golden set expects (the
// golden set's own JSON, shown as text) and the rules that grade it, by name in the visitor's language.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Lb10Target } from '../schemas'
import { useLb10Words } from '../words'

const props = defineProps<{
  target: Lb10Target
}>()

const { t } = useI18n()
const words = useLb10Words()

const note = computed(() => words.counted('lb10.targets.casesNote', props.target.sample.length, {
  total: words.number(props.target.case_count),
  hard: words.number(props.target.sample.filter(item => item.difficulty === 'hard').length),
}))

/** Writes what a case expects as indented JSON text, which is how the golden set gives it. */
function expectedText(expected: Record<string, unknown>): string {
  return JSON.stringify(expected, null, 2)
}

/** Says the rules that grade a case, each by its name in the visitor's language, or as the rule's own name when the page has none. */
function graderNames(kinds: readonly string[]): string[] {
  return kinds.map(kind => words.graderName(kind) ?? `${t('lb10.report.unknownGrader')}: ${kind}`)
}
</script>

<template>
  <details
    class="lb10-details"
    data-testid="target-cases"
  >
    <summary>{{ t('lb10.targets.cases') }}</summary>
    <p class="lb10-hint">
      {{ note }}
    </p>
    <ol class="cases">
      <li
        v-for="item in target.sample"
        :key="item.id"
        class="case"
        data-testid="target-case"
      >
        <p class="head">
          <span class="lb10-mono">{{ t('lb10.targets.case') }} {{ item.id }}</span>
          <span class="lb10-chip">{{ words.difficultyWord(item.difficulty) }}</span>
        </p>
        <p class="lb10-label">
          {{ t('lb10.targets.inputs') }}
        </p>
        <dl class="inputs">
          <div
            v-for="(value, name) in item.inputs"
            :key="name"
          >
            <dt class="lb10-mono">
              {{ name }}
            </dt>
            <dd>
              <pre
                class="lb10-text"
                tabindex="0"
                :aria-label="`${t('lb10.targets.inputs')}: ${name}`"
              >{{ value }}</pre>
            </dd>
          </div>
        </dl>
        <p class="lb10-label">
          {{ t('lb10.targets.expected') }}
        </p>
        <pre
          class="lb10-text"
          tabindex="0"
          :aria-label="t('lb10.targets.expected')"
        >{{ expectedText(item.expected) }}</pre>
        <p class="lb10-label">
          {{ t('lb10.targets.graders') }}
        </p>
        <ul class="lb10-chips">
          <li
            v-for="(name, index) in graderNames(item.grader_kinds)"
            :key="index"
            class="lb10-chip"
          >
            {{ name }}
          </li>
        </ul>
      </li>
    </ol>
  </details>
</template>

<style scoped>
.cases {
  display: grid;
  gap: 14px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.case {
  display: grid;
  gap: 6px;
  min-width: 0;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--lb-rule);
}
.head {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  align-items: center;
}
.inputs {
  display: grid;
  gap: 6px;
  margin: 0;
}
.inputs dd {
  margin: 2px 0 0;
}
.inputs .lb10-text {
  max-height: 12rem;
}
</style>
