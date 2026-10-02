<script setup lang="ts">
// <MyContracts>: the visitor's contracts of the last hour, kept by the service for that long and then
// deleted. They are listed so a visitor who reloaded the page, or stopped waiting for a review, can take
// up where they left off without spending another of the day's three contracts. A contract is the visitor's
// alone: the service finds another visitor's exactly as missing as one that was never made.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { formatMoment } from '~/board-kit/format'
import type { Lb04ContractView } from '@lb/contracts'

const props = defineProps<{
  contracts: readonly Lb04ContractView[]
  /** The contract on the board, which is not offered again. */
  activeId: string | undefined
  /** A live review is going: another contract cannot be opened until it is over. */
  busy: boolean
}>()

const emit = defineEmits<{ open: [id: string] }>()

const { t, locale } = useI18n()

const others = computed(() => props.contracts.filter(contract => contract.id !== props.activeId))
</script>

<template>
  <section
    v-if="others.length > 0"
    class="lb4-section"
    aria-labelledby="lb4-mine-heading"
    data-testid="my-contracts"
  >
    <h2 id="lb4-mine-heading">
      {{ t('lb04.mine.title') }}
    </h2>
    <p class="lb4-hint">
      {{ t('lb04.mine.note') }}
    </p>
    <ul class="list">
      <li
        v-for="contract in others"
        :key="contract.id"
        class="item lb4-panel"
      >
        <div class="what">
          <p class="name">
            {{ contract.title }}
          </p>
          <p class="lb4-hint lb4-nums">
            {{ t(`lb04.mine.states.${contract.state}`) }}
            · {{ t('lb04.mine.until', { time: formatMoment(contract.expiresAt, locale) }) }}
          </p>
        </div>
        <button
          type="button"
          class="lb4-button"
          :disabled="busy"
          @click="emit('open', contract.id)"
        >
          {{ t('lb04.mine.open') }}
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
}

.item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
}

.name {
  font-weight: 700;
  overflow-wrap: anywhere;
}
</style>
