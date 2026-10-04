<script setup lang="ts">
// <RedlineView>: a proposed change to one finding's passage, shown as real text. The server computes the
// difference between the contract's own words and the proposal, word by word, and this draws it: words
// both share as they are, words the proposal would remove struck through, words it would add underlined,
// each with a word for it that a screen reader says, since a line through text is not read out. Below the
// difference the proposal is written out whole, so it can be read and copied without the marks. A redline
// is a suggestion for a person to weigh and always carries the label "Not legal advice".
import type { Lb04Redline } from '@lb/contracts'
import { useI18n } from 'vue-i18n'

defineProps<{
  redline: Lb04Redline
  /** The Brief reading leaves out how the wording was made. */
  brief: boolean
}>()

const { t } = useI18n()
</script>

<template>
  <div
    class="redline"
    data-testid="redline"
  >
    <div class="lb4-row">
      <h4 class="title">
        {{ t('lb04.redline.title') }}
      </h4>
      <span class="lb4-chip">{{ t('lb04.notLegalAdvice') }}</span>
    </div>

    <p
      v-if="redline.diff.length > 0 && redline.original !== ''"
      class="diff"
      data-testid="redline-diff"
    >
      <template
        v-for="(part, index) in redline.diff"
        :key="index"
      >
        <template v-if="index > 0">
          {{ ' ' }}
        </template>
        <del
          v-if="part.op === 'delete'"
          class="lb4-del"
        ><span class="lb-sr-only">{{ t('lb04.redline.removed') }} </span>{{ part.text }}</del>
        <ins
          v-else-if="part.op === 'insert'"
          class="lb4-ins"
        ><span class="lb-sr-only">{{ t('lb04.redline.added') }} </span>{{ part.text }}</ins>
        <span v-else>{{ part.text }}</span>
      </template>
    </p>

    <div class="whole">
      <p class="lb-label">
        {{ t('lb04.redline.proposal') }}
      </p>
      <p
        class="proposal"
        data-testid="redline-proposal"
      >
        {{ redline.proposal }}
      </p>
    </div>

    <p
      v-if="!brief"
      class="lb4-hint"
    >
      {{ redline.original === '' ? t('lb04.redline.missingClause') : t('lb04.redline.diffNote') }}
      {{ redline.source === 'model' ? t('lb04.redline.fromModel') : t('lb04.redline.fromPlaybook') }}
    </p>
  </div>
</template>

<style scoped>
.redline {
  display: grid;
  gap: 8px;
  padding: 10px 12px;
  background: var(--lb-shade);
  border-left: 3px solid var(--lb-ink);
}

.title {
  font-size: 14px;
  font-weight: 700;
}

.diff,
.proposal {
  max-width: 70ch;
  font-size: 14px;
  line-height: 1.6;
}

.whole {
  display: grid;
  gap: 2px;
}
</style>
