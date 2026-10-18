<script setup lang="ts">
// <SiteToolbar>: the sticky bar at the top of every page, with the brand, the section
// links, and the language and theme switches.
import type { ColorPreference } from '@lb/ui/types'

const { t } = useI18n()
const colorMode = useColorMode()

// The theme switch's value: the visitor's own choice, or `system` when they left it to
// the operating system. Writing it saves the choice (in localStorage, never a cookie).
const preference = computed<ColorPreference>({
  get: () => (['light', 'dark'].includes(colorMode.preference) ? colorMode.preference : 'system') as ColorPreference,
  set: (value) => {
    colorMode.preference = value
  },
})

// The theme switch's text, in the page's language.
const themeLabels = computed(() => ({
  group: t('toolbar.theme.group'),
  light: t('toolbar.theme.light'),
  dark: t('toolbar.theme.dark'),
  system: t('toolbar.theme.system'),
}))
</script>

<template>
  <header class="toolbar">
    <NuxtLinkLocale
      to="/"
      class="brand"
    >
      <LbLogo
        :height="20"
        label=""
      />
      <span class="wordmark">Landry Bodjona</span>
    </NuxtLinkLocale>
    <nav
      class="nav"
      :aria-label="t('toolbar.sections')"
    >
      <NuxtLinkLocale :to="{ path: '/', hash: '#systems' }">
        {{ t('toolbar.systems') }}
      </NuxtLinkLocale>
      <NuxtLinkLocale :to="{ path: '/', hash: '#build' }">
        {{ t('toolbar.build') }}
      </NuxtLinkLocale>
      <NuxtLinkLocale :to="{ path: '/', hash: '#about' }">
        {{ t('toolbar.about') }}
      </NuxtLinkLocale>
      <NuxtLinkLocale class="contact-link" :to="{ path: '/', hash: '#contact' }">
        {{ t('toolbar.contact') }} <span aria-hidden="true">↗</span>
      </NuxtLinkLocale>
    </nav>
    <div class="controls">
      <details class="mobile-menu">
        <summary :aria-label="t('toolbar.menu')">
          <span class="menu-bars" aria-hidden="true">☰</span>
        </summary>
        <nav :aria-label="t('toolbar.sections')" class="mobile-menu-panel">
          <NuxtLinkLocale :to="{ path: '/', hash: '#featured' }">
            {{ t('toolbar.systems') }}
          </NuxtLinkLocale>
          <NuxtLinkLocale :to="{ path: '/', hash: '#build' }">
            {{ t('toolbar.build') }}
          </NuxtLinkLocale>
          <NuxtLinkLocale :to="{ path: '/', hash: '#about' }">
            {{ t('toolbar.about') }}
          </NuxtLinkLocale>
          <NuxtLinkLocale :to="{ path: '/', hash: '#contact' }">
            {{ t('toolbar.contact') }}
          </NuxtLinkLocale>
        </nav>
      </details>
      <LanguageSwitch />
      <!-- The saved theme is only known in the browser, so the toggle renders there;
           the slot keeps its width so nothing shifts when it appears. -->
      <ClientOnly>
        <LbThemeToggle
          v-model="preference"
          :labels="themeLabels"
        />
        <template #fallback>
          <span
            class="toggle-slot"
            aria-hidden="true"
          />
        </template>
      </ClientOnly>
    </div>
  </header>
</template>

<style scoped>
.toolbar {
  position: sticky;
  top: env(safe-area-inset-top, 0px);
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 18px;
  margin-inline: calc(var(--lb-gutter) * -1);
  padding: 10px var(--lb-gutter);
  background: var(--lb-desk);
  border-bottom: 1px solid var(--lb-rule);
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--lb-ink);
  text-decoration: none;
}

.wordmark {
  font-size: 13px;
  font-weight: 800;
  font-stretch: 125%;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  white-space: nowrap;
}

.nav {
  display: flex;
  gap: 16px;
  margin-left: auto;
}

.nav a {
  padding-block: 2px;
  font-size: 13px;
  color: var(--lb-ink);
  text-decoration: none;
  border-bottom: 1px solid transparent;
}

.nav a:hover {
  border-bottom-color: var(--lb-ink);
}

.controls {
  display: flex;
  align-items: center;
  gap: 10px;
}

.toggle-slot {
  display: inline-block;
  width: 128px;
  height: 35px;
}

@media (max-width: 640px) {
  .nav {
    display: none;
  }

  .controls {
    margin-left: auto;
  }

  .wordmark {
    font-size: 12px;
  }
}

/* On the narrowest phones the language and theme switches need the room, so the
   wordmark is hidden from sight but still names the home link for screen readers. */
@media (max-width: 480px) {
  .wordmark {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
}

.toolbar {
  min-height: 70px;
  padding-inline: max(22px, calc((100vw - 1440px) / 2 + 34px));
  background: rgb(7 12 23 / 93%);
  border-bottom: 1px solid rgb(127 169 224 / 20%);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
}
.toolbar .brand { color: #f4f8ff; }
.toolbar .nav { align-items: center; gap: clamp(14px, 2vw, 32px); }
.toolbar .nav a { color: #c6d8ef; font-size: 12px; }
.toolbar .nav a:hover { color: #fff; border-bottom-color: #81d9ff; }
.toolbar .nav .contact-link {
  display: inline-flex; align-items: center; min-height: 39px; gap: 12px;
  margin-left: 8px; padding: 0 17px; border: 1px solid #6abefa;
  border-radius: 6px; box-shadow: 0 0 22px rgb(26 118 255 / 12%);
  color: #d8efff; font-weight: 700;
}
.toolbar .nav .contact-link:hover { background: rgb(54 133 230 / 20%); }
.mobile-menu { display: none; position: relative; }
.mobile-menu summary {
  display: grid; place-items: center; width: 42px; min-height: 42px;
  border: 1px solid rgb(120 171 239 / 37%); border-radius: 7px;
  color: #e8f4ff; list-style: none; cursor: pointer;
}
.mobile-menu summary::-webkit-details-marker { display: none; }
.menu-bars { font-size: 22px; line-height: 1; }
.mobile-menu-panel {
  position: absolute; z-index: 40; top: 52px; right: 0; display: grid;
  width: min(280px, 85vw); padding: 10px; border: 1px solid #36557b;
  border-radius: 9px; background: #0b1627; box-shadow: 0 20px 35px #0009;
}
.mobile-menu-panel a {
  min-height: 46px; display: flex; align-items: center; padding: 9px 15px;
  color: #eaf3ff; text-decoration: none; border-radius: 4px;
}
.mobile-menu-panel a:hover { background: #152c49; }
@media (max-width: 850px) {
  .toolbar .nav { display: none; }
  .mobile-menu { display: block; }
  .toolbar { gap: 8px; padding-inline: 14px; }
  .controls { margin-left: auto; gap: 8px; }
}
@media (max-width: 600px) {
  .toolbar .wordmark { display: none; }
  .toolbar .toggle-slot { width: 0; }
}
</style>
