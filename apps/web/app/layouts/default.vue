<script setup lang="ts">
// The default layout, used by every page and by the error page: the head every page
// shares, a skip link for keyboard users, the toolbar, the page on its sheet, and the
// footer. The head lives here, not in app.vue, because Nuxt renders error pages without
// app.vue, and a 404 still needs its language and favicon.
import favicon from '#brand/lb-favicon.svg?url'

const { t } = useI18n()

// `lang` on <html> (screen readers pick their voice from it), plus hreflang alternates
// and og:locale so search engines pair the English and Czech versions of each page.
const localeHead = useLocaleHead({ dir: false, lang: true, seo: true })

useHead(() => ({
  htmlAttrs: { lang: localeHead.value.htmlAttrs.lang },
  link: [{ rel: 'icon', type: 'image/svg+xml', href: favicon }, ...localeHead.value.link],
  meta: [...localeHead.value.meta],
}))
useSeoMeta({ description: () => t('site.description') })
</script>

<template>
  <div class="site">
    <a
      class="skip"
      href="#main"
    >{{ t('site.skip') }}</a>
    <SiteToolbar />
    <main
      id="main"
      class="sheet"
      tabindex="-1"
    >
      <slot />
    </main>
    <SiteFooter />
  </div>
</template>

<style scoped>
.site {
  padding-inline: var(--lb-gutter);
  padding-block: 0 56px;
}

.skip {
  position: absolute;
  left: 12px;
  top: -60px;
  z-index: 40;
  padding: 10px 14px;
  font-weight: 700;
  color: var(--lb-sheet);
  background: var(--lb-ink);
  border-radius: 4px;
}

.skip:focus {
  top: 12px;
}

.sheet {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: clamp(44px, 6vw, 76px);
  max-width: 1180px;
  margin: 24px auto 0;
  padding: clamp(18px, 4.5vw, 56px);
  background: var(--lb-sheet);
  border: 1px solid var(--lb-rule);
}

.sheet:focus {
  outline: none;
}

@media (max-width: 640px) {
  .sheet {
    margin-top: 16px;
    padding: 20px 14px;
  }
}
</style>
