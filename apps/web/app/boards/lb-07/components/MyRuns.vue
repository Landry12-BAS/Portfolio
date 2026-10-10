<script setup lang="ts">
// <MyRuns>: the visitor's runs of the last hour, so a reload does not lose them. The service keeps a run,
// its report, its test and its evidence for an hour, and the board lists each here with what it was (a
// curated run by its title, or the visitor's own goal) and where it stands, with a button that opens it: a
// finished run is read whole, one still going is followed again.
import { storeToRefs } from 'pinia'
import { useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLb07Store } from '../store'
import { useLb07Words } from '../words'

const { t } = useI18n()
const words = useLb07Words()
const store = useLb07Store()
const { mine, mineStatus, run, busy } = storeToRefs(store)
const id = useId()
</script>

<template>
  <section
    class="lb7-panel"
    :aria-labelledby="`${id}-title`"
    data-testid="my-runs"
  >
    <h3 :id="`${id}-title`">
      {{ t('lb07.mine.title') }}
    </h3>
    <p
      v-if="mineStatus === 'loading' && mine.length === 0"
      class="lb7-hint"
    >
      {{ t('lb07.mine.loading') }}
    </p>
    <p
      v-else-if="mine.length === 0"
      class="lb7-hint"
    >
      {{ t('lb07.mine.none') }}
    </p>
    <ul
      v-else
      class="list"
    >
      <li
        v-for="item in mine"
        :key="item.id"
        data-testid="my-run"
      >
        <span>{{ t('lb07.mine.line', { title: item.sampleId === null ? t('lb07.mine.own') : words.sampleTitle(item.sampleId), state: words.stateWord(item.state) }) }}</span>
        <span
          v-if="run?.id === item.id"
          class="lb7-hint"
        >{{ t('lb07.mine.shown') }}</span>
        <button
          v-else
          type="button"
          class="lb7-button lb7-button--quiet"
          :disabled="busy"
          data-testid="open-run"
          @click="store.openRun(item.id)"
        >
          {{ t('lb07.mine.open') }}
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.list {
  display: grid;
  gap: 8px;
  padding: 0;
  margin: 0;
  list-style: none;
  font-size: 13.5px;
}
.list li {
  display: grid;
  gap: 6px;
  justify-items: start;
}
</style>
