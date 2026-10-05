<script setup lang="ts">
// <MyIncident>: the incident the visitor started today, so a reload does not lose it. The service
// keeps an incident and its log for a day, one incident a visitor, and the board lists it here with
// a button that opens it: its whole log is read again, and it is followed if it is still going.
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useLb06Store } from '../store'
import { useLb06Words } from '../words'

const { t } = useI18n()
const words = useLb06Words()
const store = useLb06Store()
const { mine, mineStatus, incident, busy } = storeToRefs(store)
</script>

<template>
  <section
    class="lb6-panel"
    :aria-label="t('lb06.mine.title')"
    data-testid="my-incident"
  >
    <h3>{{ t('lb06.mine.title') }}</h3>
    <p
      v-if="mineStatus === 'loading'"
      class="lb6-hint"
    >
      {{ t('lb06.mine.loading') }}
    </p>
    <p
      v-else-if="mine.length === 0"
      class="lb6-hint"
    >
      {{ t('lb06.mine.none') }}
    </p>
    <ul
      v-else
      class="list"
    >
      <li
        v-for="item in mine"
        :key="item.id"
      >
        <span>{{ words.faultName(item.scenario.fault) }}: {{ t('lb06.mine.line', { state: words.stateWord(item.state), minute: item.minute }) }}</span>
        <button
          type="button"
          class="lb6-button lb6-button--quiet"
          :disabled="busy !== 'idle' || incident?.id === item.id"
          data-testid="open-mine"
          @click="store.openMine(item)"
        >
          {{ t('lb06.mine.open') }}
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
