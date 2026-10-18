<script setup lang="ts">
// Responsive site header. Keep language and theme settings inside the mobile drawer;
// desktop retains its compact inline controls.
import type { ColorPreference } from '@lb/ui/types'

const { t } = useI18n()
const route = useRoute()
const colorMode = useColorMode()
const mobileOpen = ref(false)
const toolbarRef = ref<HTMLElement | null>(null)

const preference = computed<ColorPreference>({
  get: () => (['light', 'dark'].includes(colorMode.preference) ? colorMode.preference : 'system') as ColorPreference,
  set: (value) => {
    colorMode.preference = value
  },
})

const themeLabels = computed(() => ({
  group: t('toolbar.theme.group'),
  light: t('toolbar.theme.light'),
  dark: t('toolbar.theme.dark'),
  system: t('toolbar.theme.system'),
}))

/** Close the mobile menu after navigation or dismissal. */
function closeMobileMenu() {
  mobileOpen.value = false
}

/** Dismiss the menu if the user interacts outside the sticky header. */
function closeOnOutsidePointer(event: PointerEvent) {
  if (mobileOpen.value && event.target instanceof Node && !toolbarRef.value?.contains(event.target)) {
    closeMobileMenu()
  }
}

// Closing on navigation prevents an open menu after clicking a same-page anchor,
// changing the language, or using the browser back button.
watch(() => route.fullPath, closeMobileMenu)
/** Keep Escape working even if focus moves from the menu to the page. */
function closeOnEscape(event: KeyboardEvent) {
  if (event.key === 'Escape') closeMobileMenu()
}

onMounted(() => {
  document.addEventListener('pointerdown', closeOnOutsidePointer)
  document.addEventListener('keydown', closeOnEscape)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', closeOnOutsidePointer)
  document.removeEventListener('keydown', closeOnEscape)
})
</script>

<template>
  <header
    ref="toolbarRef"
    class="toolbar"
  >
    <NuxtLinkLocale
      to="/"
      class="brand"
      @click="closeMobileMenu"
    >
      <LbLogo
        :height="20"
        label=""
      />
      <span class="wordmark">Landry Bodjona</span>
    </NuxtLinkLocale>

    <nav
      class="desktop-nav"
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
      <NuxtLinkLocale
        class="contact-link"
        :to="{ path: '/', hash: '#contact' }"
      >
        {{ t('toolbar.contact') }}
        <span aria-hidden="true">↗</span>
      </NuxtLinkLocale>
    </nav>

    <div class="desktop-controls">
      <LanguageSwitch />
      <!-- User preference is resolved in the browser. -->
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

    <button
      type="button"
      class="mobile-trigger"
      :aria-label="mobileOpen ? t('toolbar.closeMenu') : t('toolbar.menu')"
      :aria-expanded="mobileOpen"
      aria-controls="mobile-navigation-panel"
      @click="mobileOpen = !mobileOpen"
    >
      <span
        class="trigger-lines"
        aria-hidden="true"
      >
        <span />
        <span />
        <span />
      </span>
    </button>

    <div
      v-show="mobileOpen"
      id="mobile-navigation-panel"
      class="mobile-panel"
    >
      <nav
        class="mobile-nav"
        :aria-label="t('toolbar.sections')"
      >
        <NuxtLinkLocale
          :to="{ path: '/', hash: '#featured' }"
          @click="closeMobileMenu"
        >
          {{ t('toolbar.systems') }}
        </NuxtLinkLocale>
        <NuxtLinkLocale
          :to="{ path: '/', hash: '#build' }"
          @click="closeMobileMenu"
        >
          {{ t('toolbar.build') }}
        </NuxtLinkLocale>
        <NuxtLinkLocale
          :to="{ path: '/', hash: '#about' }"
          @click="closeMobileMenu"
        >
          {{ t('toolbar.about') }}
        </NuxtLinkLocale>
        <NuxtLinkLocale
          :to="{ path: '/', hash: '#contact' }"
          @click="closeMobileMenu"
        >
          {{ t('toolbar.contact') }}
        </NuxtLinkLocale>
      </nav>

      <div class="mobile-preferences">
        <div class="preference-row">
          <p class="preference-label">
            {{ t('toolbar.language') }}
          </p>
          <LanguageSwitch />
        </div>
        <div class="preference-row">
          <p class="preference-label">
            {{ t('toolbar.theme.group') }}
          </p>
          <ClientOnly>
            <LbThemeToggle
              v-model="preference"
              :labels="themeLabels"
            />
          </ClientOnly>
        </div>
      </div>
    </div>
  </header>
</template>

<style scoped>
.toolbar {
  position: sticky;
  top: env(safe-area-inset-top, 0px);
  z-index: 30;
  display: flex;
  align-items: center;
  gap: clamp(12px, 2vw, 24px);
  min-height: 70px;
  margin-inline: calc(var(--lb-gutter) * -1);
  padding: 10px max(22px, calc((100vw - 1440px) / 2 + 34px));
  color: #f4f8ff;
  background: rgb(7 12 23 / 97%);
  border-bottom: 1px solid rgb(127 169 224 / 25%);
  -webkit-backdrop-filter: blur(20px);
  backdrop-filter: blur(20px);
}
.brand {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 10px;
  color: #f4f8ff;
  text-decoration: none;
}
.wordmark {
  font-size: 13px;
  font-weight: 800;
  font-stretch: 125%;
  letter-spacing: .07em;
  text-transform: uppercase;
  white-space: nowrap;
}
.desktop-nav {
  display: flex;
  align-items: center;
  gap: clamp(14px, 2vw, 32px);
  margin-left: auto;
}
.desktop-nav a {
  padding-block: 2px;
  color: #c6d8ef;
  font-size: 12px;
  text-decoration: none;
  border-bottom: 1px solid transparent;
}
.desktop-nav a:hover {
  color: #fff;
  border-bottom-color: #81d9ff;
}
.desktop-nav .contact-link {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  min-height: 39px;
  margin-left: 8px;
  padding: 0 17px;
  color: #d8efff;
  font-weight: 700;
  border: 1px solid #6abefa;
  border-radius: 6px;
  box-shadow: 0 0 22px rgb(26 118 255 / 12%);
}
.desktop-nav .contact-link:hover {
  background: rgb(54 133 230 / 20%);
}
.desktop-controls {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
}
.toggle-slot {
  display: inline-block;
  width: 128px;
  height: 35px;
}
.mobile-trigger, .mobile-panel {
  display: none;
}
@media (max-width: 850px) {
  .toolbar {
    gap: 12px;
    justify-content: space-between;
    padding-inline: max(16px, env(safe-area-inset-left, 0px));
  }
  .desktop-nav, .desktop-controls {
    display: none;
  }
  .mobile-trigger {
    display: grid;
    flex: none;
    place-items: center;
    width: 46px;
    min-height: 46px;
    margin-left: auto;
    padding: 0;
    color: #edf7ff;
    background: rgb(20 41 69 / 75%);
    border: 1px solid #416991;
    border-radius: 10px;
    cursor: pointer;
  }
  .mobile-trigger:hover, .mobile-trigger[aria-expanded="true"] {
    border-color: #85d4ff;
    background: #193958;
  }
  .mobile-trigger:focus-visible {
    outline: 2px solid #a4e6ff;
    outline-offset: 4px;
  }
  .trigger-lines {
    display: grid;
    align-content: center;
    gap: 5px;
    width: 21px;
    height: 23px;
  }
  .trigger-lines span {
    display: block;
    width: 100%;
    height: 2px;
    border-radius: 4px;
    background: currentColor;
    transition: transform 170ms ease, opacity 170ms ease;
  }
  .mobile-trigger[aria-expanded="true"] .trigger-lines span:first-child {
    transform: translateY(7px) rotate(45deg);
  }
  .mobile-trigger[aria-expanded="true"] .trigger-lines span:nth-child(2) {
    opacity: 0;
  }
  .mobile-trigger[aria-expanded="true"] .trigger-lines span:last-child {
    transform: translateY(-7px) rotate(-45deg);
  }
  .mobile-panel {
    position: absolute;
    top: calc(100% + 6px);
    right: max(12px, env(safe-area-inset-right, 0px));
    z-index: 50;
    box-sizing: border-box;
    display: block;
    width: min(360px, calc(100vw - 24px));
    max-width: calc(100vw - 24px);
    max-height: calc(100dvh - 100px);
    overflow-x: hidden;
    overflow-y: auto;
    padding: 18px;
    border: 1px solid #3d648e;
    border-radius: 14px;
    background: #0c192b;
    box-shadow: 0 26px 72px rgb(0 0 0 / 65%), 0 0 36px rgb(30 115 221 / 14%);
  }
  .mobile-panel[style*="display: none"] {
    display: none;
  }
  .mobile-nav {
    display: grid;
    gap: 4px;
  }
  .mobile-nav a {
    display: flex;
    align-items: center;
    min-height: 48px;
    padding: 10px 13px;
    color: #eaf4ff;
    font-size: 15px;
    font-weight: 650;
    text-decoration: none;
    border-radius: 8px;
  }
  .mobile-nav a:hover, .mobile-nav a:focus-visible {
    color: #fff;
    background: #183453;
  }
  .mobile-preferences {
    display: grid;
    gap: 20px;
    min-width: 0;
    margin-top: 16px;
    padding-top: 22px;
    border-top: 1px solid #35506b;
  }
  .preference-row {
    display: grid;
    gap: 11px;
    min-width: 0;
  }
  .preference-label {
    color: #a9c6e6;
    font: 600 11px/1.35 var(--lb-font-mono);
    letter-spacing: .08em;
    text-transform: uppercase;
  }
  .mobile-preferences :deep(.langs) {
    width: max-content;
    max-width: 100%;
    border-color: #6f91b8;
  }
  .mobile-preferences :deep(.lang) {
    color: #dcefff;
  }
  .mobile-preferences :deep(.lang + .lang) {
    border-color: #6f91b8;
  }
  .mobile-preferences :deep(.lang[aria-current="true"]) {
    color: #051525;
    background: #a4e5ff;
  }
}
@media (max-width: 480px) {
  .wordmark {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }
}
@media (prefers-reduced-motion: reduce) {
  .trigger-lines span {
    transition: none;
  }
}
</style>
