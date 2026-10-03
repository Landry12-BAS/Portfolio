<script setup lang="ts">
// <SiteFooter>: the product folder (a link to every part's datasheet) and the note that
// the company and its data are fictional.
const { t } = useI18n()
const datasheets = useDatasheets()
</script>

<template>
  <footer class="foot">
    <nav
      class="folder"
      :aria-label="t('footer.allParts')"
    >
      <span class="lb-label">{{ t('footer.folder') }}</span>
      <NuxtLinkLocale
        v-for="system in datasheets"
        :key="system.part"
        :to="`/systems/${system.slug}`"
      >
        {{ system.part }}
      </NuxtLinkLocale>
    </nav>
    <p>{{ t('footer.note') }}</p>
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

/* Each link is at least 24 by 24 CSS pixels (WCAG 2.2, 2.5.8): the part numbers are small, and where
   the folder wraps onto a second line, as it does on a phone, the links are too close to count as apart. */
.folder a {
  display: inline-flex;
  align-items: center;
  min-width: 24px;
  min-height: 24px;
  font-family: var(--lb-font-mono);
  font-size: 11px;
  font-weight: 700;
}
</style>
