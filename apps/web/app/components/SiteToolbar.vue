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
    </nav>
    <div class="controls">
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
</style>
