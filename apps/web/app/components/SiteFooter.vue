<script setup lang="ts">
import { systems } from '#shared/data/systems'
</script>

<template>
  <footer class="foot">
    <nav
      class="folder"
      aria-label="All parts"
    >
      <span class="lb-label">Product folder</span>
      <NuxtLink
        v-for="system in systems"
        :key="system.part"
        :to="`/systems/${system.slug}`"
      >
        {{ system.part }}
      </NuxtLink>
    </nav>
    <p>Landry Bodjona · LB. Basalt &amp; Bean Coffee Co. is fictional, and every demo runs on synthetic data.</p>
  </footer>
</template>

<style scoped>
.foot {
  display: grid;
  gap: 10px;
  max-width: 1180px;
  margin: 28px auto 0;
  padding-top: 14px;
  font-size: 13px;
  color: var(--lb-graphite);
  border-top: 3px solid var(--lb-ink);
}

.folder {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 14px;
}

.folder a {
  font-family: var(--lb-font-mono);
  font-size: 11px;
  font-weight: 700;
}
</style>
