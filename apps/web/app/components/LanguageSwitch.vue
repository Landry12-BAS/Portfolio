<script setup lang="ts">
// <LanguageSwitch>: links to the current page in each of the site's languages. They
// are plain links, so they work before any script runs and search engines follow
// them. Each link is named in its own language ("EN English", "CZ Čeština").
const { locale, locales, t } = useI18n()
const switchLocalePath = useSwitchLocalePath()

// Czech readers know their language as CZ, the country code, so that is the label;
// the code in the URL and in `lang` stays `cs`, the standard language code.
const shortLabels: Record<string, string> = { en: 'EN', cs: 'CZ' }

// One entry per language: where it links, its short label, full name and language tag.
const links = computed(() => locales.value.map(item => ({
  code: item.code,
  to: switchLocalePath(item.code),
  short: shortLabels[item.code] ?? item.code.toUpperCase(),
  name: item.name ?? item.code,
  language: item.language ?? item.code,
})))
</script>

<template>
  <nav
    class="langs"
    :aria-label="t('toolbar.language')"
  >
    <NuxtLink
      v-for="link in links"
      :key="link.code"
      :to="link.to"
      class="lang"
      :lang="link.language"
      :hreflang="link.language"
      :aria-current="link.code === locale ? 'true' : undefined"
    >
      {{ link.short }}<span class="lb-sr-only"> {{ link.name }}</span>
    </NuxtLink>
  </nav>
</template>

<style scoped>
.langs {
  display: inline-flex;
  flex: none;
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
  overflow: hidden;
}

.lang {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 36px;
  min-height: 32px;
  padding: 0 10px;
  font: 600 11.5px/1 var(--lb-font-mono);
  letter-spacing: 0.06em;
  color: var(--lb-ink);
  text-decoration: none;
}

.lang + .lang {
  border-left: 1.5px solid var(--lb-ink);
}

.lang:hover {
  background: var(--lb-shade);
}

.lang[aria-current="true"] {
  color: var(--lb-sheet);
  background: var(--lb-ink);
}

.lang:focus-visible {
  outline-offset: -4px;
}
</style>
