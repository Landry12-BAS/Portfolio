<script setup lang="ts">
// <MyWorkflows>: the workflows the visitor keeps for the day, so a reload or a second visit takes up
// where the first left off, and so a visitor who has reached the limit of twenty can delete one to
// make another. Opening one is a read; deleting one changes something, so it needs the check.
import { RUN_LIMITS } from '@lb/contracts'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'

import { useLb08Store } from '../store'

const { t } = useI18n()
const store = useLb08Store()
const { mine, mineStatus, workflow, busy } = storeToRefs(store)
</script>

<template>
  <section
    class="lb8-panel"
    :aria-label="t('lb08.workflows.title')"
    data-testid="my-workflows"
  >
    <h3>{{ t('lb08.workflows.title') }}</h3>
    <p
      v-if="mineStatus === 'failed'"
      class="lb8-hint"
    >
      {{ t('lb08.workflows.failed') }}
    </p>
    <p
      v-else-if="mine.length === 0"
      class="lb8-hint"
    >
      {{ t('lb08.workflows.empty') }}
    </p>
    <template v-else>
      <p class="lb8-hint">
        {{ t('lb08.workflowsLabel') }}: {{ t('lb08.workflows.count', { count: mine.length, max: RUN_LIMITS.maxWorkflowsPerVisitor }) }}
      </p>
      <ul class="list">
        <li
          v-for="item in mine"
          :key="item.id"
          class="item"
          :class="{ open: workflow?.id === item.id }"
          data-testid="my-workflow"
        >
          <span class="name">{{ item.name }}</span>
          <button
            type="button"
            class="lb8-button lb8-button--quiet"
            :disabled="busy !== 'idle' || workflow?.id === item.id"
            :aria-label="t('lb08.workflows.openLabel', { name: item.name })"
            @click="store.openMine(item.id)"
          >
            {{ t('lb08.workflows.open') }}
          </button>
          <button
            type="button"
            class="lb8-button lb8-button--quiet"
            :aria-label="t('lb08.workflows.deleteLabel', { name: item.name })"
            @click="store.deleteMine(item.id)"
          >
            {{ t('lb08.workflows.delete') }}
          </button>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.list {
  display: grid;
  gap: 6px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.item {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 4px 6px;
  border-left: 3px solid var(--lb-rule);
}

.item.open {
  border-left-color: var(--lb-board);
}

.name {
  flex: 1 1 120px;
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 13.5px;
  font-weight: 600;
}
</style>
