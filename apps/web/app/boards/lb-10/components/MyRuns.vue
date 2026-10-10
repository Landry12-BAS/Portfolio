<script setup lang="ts">
// <MyRuns>: the visitor's runs of today, so a reload does not lose them. The service keeps a run and its report for a
// week and lists the day's, newest first; the board lists each with the prompt it measured and where it stands, with a
// button that opens it: a finished run shows its report, one still going is followed again. The service keeps only a
// fingerprint of the visitor's prompt, so a run opened again shows its report and not their text, as the note says.
import { storeToRefs } from 'pinia'
import { useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatMoment } from '~/board-kit/format'
import { useLb10Store } from '../store'
import { useLb10Words } from '../words'

const { t, locale } = useI18n()
const words = useLb10Words()
const store = useLb10Store()
const { mine, mineStatus, run, busy, targets } = storeToRefs(store)
const id = useId()

/** Names the prompt a run measured. */
function targetOf(pack: string): string {
  return words.packTitle(pack, targets.value?.targets.find(item => item.pack === pack)?.name)
}
</script>

<template>
  <section
    class="lb10-panel"
    :aria-labelledby="`${id}-title`"
    data-testid="my-runs"
  >
    <h3 :id="`${id}-title`">
      {{ t('lb10.mine.title') }}
    </h3>
    <p
      v-if="mineStatus === 'loading' && mine.length === 0"
      class="lb10-hint"
    >
      {{ t('lb10.mine.loading') }}
    </p>
    <p
      v-else-if="mineStatus === 'failed' && mine.length === 0"
      class="lb10-hint"
    >
      {{ t('lb10.mine.failed') }}
    </p>
    <p
      v-else-if="mine.length === 0"
      class="lb10-hint"
    >
      {{ t('lb10.mine.none') }}
    </p>
    <ul
      v-else
      class="list"
    >
      <li
        v-for="item in mine"
        :key="item.run_id"
        data-testid="my-run"
        :data-state="item.state"
      >
        <span>{{ t('lb10.mine.line', { target: targetOf(item.pack), state: words.stateWord(item.state) }) }}</span>
        <span class="lb10-hint">{{ formatMoment(item.started_at, locale) }}</span>
        <span
          v-if="run?.run_id === item.run_id"
          class="lb10-hint"
        >{{ t('lb10.mine.shown') }}</span>
        <button
          v-else
          type="button"
          class="lb10-button lb10-button--quiet"
          :disabled="busy"
          data-testid="open-run"
          @click="store.openRun(item.run_id)"
        >
          {{ t('lb10.mine.open') }}
        </button>
      </li>
    </ul>
    <p class="lb10-hint">
      {{ t('lb10.mine.note') }}
    </p>
  </section>
</template>

<style scoped>
.list {
  display: grid;
  gap: 10px;
  padding: 0;
  margin: 0;
  list-style: none;
  font-size: 13.5px;
}
.list li {
  display: grid;
  gap: 4px;
  justify-items: start;
}
</style>
