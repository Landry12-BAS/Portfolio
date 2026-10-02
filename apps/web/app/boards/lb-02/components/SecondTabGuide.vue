<script setup lang="ts">
// <SecondTabGuide>: how to try to double-book a slot with two browser tabs. The calendar is shared by
// everyone, and a tab of this board is a conversation of its own, so a second tab is a second visitor
// as far as the calendar is concerned. The guide says what to do in each tab and what to expect, and
// why the second booking cannot succeed whatever the model says: a database constraint refuses it. The
// link opens the board in a new tab in the visitor's language.
import { LbIcon } from '@lb/icons'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <section
    class="guide"
    :aria-label="t('lb02.second.title')"
    data-testid="second-tab"
  >
    <h2 class="lb-label">
      {{ t('lb02.second.title') }}
    </h2>
    <p class="intro">
      {{ t('lb02.second.intro') }}
    </p>
    <ol class="steps">
      <li>{{ t('lb02.second.step1') }}</li>
      <li>{{ t('lb02.second.step2') }}</li>
      <li>{{ t('lb02.second.step3') }}</li>
      <li>{{ t('lb02.second.step4') }}</li>
    </ol>
    <p class="why">
      {{ t('lb02.second.why') }}
    </p>
    <NuxtLinkLocale
      to="/systems/lb-02/board"
      target="_blank"
      rel="noopener"
      class="open"
      data-testid="open-second-tab"
    >
      {{ t('lb02.second.open') }}
      <LbIcon
        name="arrow-up-right"
        :size="16"
        tone="mono"
      />
    </NuxtLinkLocale>
  </section>
</template>

<style scoped>
.guide {
  display: grid;
  gap: 10px;
  padding: 16px;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-rule);
}

.intro,
.steps,
.why {
  max-width: 68ch;
  font-size: 14px;
}

.steps {
  display: grid;
  gap: 6px;
  padding-left: 22px;
  margin: 0;
}

.why {
  color: var(--lb-graphite);
}

.open {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  justify-self: start;
  padding: 9px 16px;
  font: 600 14px/1 var(--lb-font-sans);
  color: var(--lb-ink);
  text-decoration: none;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-ink);
}

.open:hover {
  background: var(--lb-shade);
}
</style>
