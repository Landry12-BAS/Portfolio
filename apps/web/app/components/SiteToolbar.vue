<script setup lang="ts">
// Responsive site header. Keep language and theme settings inside the mobile drawer;
// desktop retains its compact inline controls.
import type { ColorPreference } from '@lb/ui/types'

const { t } = useI18n()
const route = useRoute()
const colorMode = useColorMode()
const mobileOpen = ref(false)
const toolbarRef = ref<HTMLElement | null>(null)
let openScrollY = 0

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

const mobileThemes = computed<{ value: ColorPreference, label: string, icon: string }[]>(() => [
  { value: 'light', label: themeLabels.value.light, icon: '☀' },
  { value: 'dark', label: themeLabels.value.dark, icon: '☾' },
  { value: 'system', label: themeLabels.value.system, icon: '◉' },
])

/** Close the mobile menu after navigation or dismissal. */
function closeMobileMenu() {
  mobileOpen.value = false
}

/** Toggle the drawer and remember the page position at which it opened. */
function toggleMobileMenu() {
  if (mobileOpen.value) {
    closeMobileMenu()
  }
  else {
    openScrollY = window.scrollY
    mobileOpen.value = true
  }
}

/** Close the drawer when the document scrolls, not when its own contents scroll. */
function closeOnPageScroll() {
  if (mobileOpen.value && Math.abs(window.scrollY - openScrollY) > 8) {
    closeMobileMenu()
  }
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
  window.addEventListener('scroll', closeOnPageScroll, { passive: true })
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', closeOnOutsidePointer)
  document.removeEventListener('keydown', closeOnEscape)
  window.removeEventListener('scroll', closeOnPageScroll)
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
      @click="toggleMobileMenu"
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
      <div class="mobile-menu-heading">
        <span>{{ t('toolbar.menu') }}</span>
        <span class="menu-heading-mark" aria-hidden="true">LB / 2026</span>
      </div>
      <nav
        class="mobile-nav"
        :aria-label="t('toolbar.sections')"
      >
        <NuxtLinkLocale
          :to="{ path: '/', hash: '#featured' }"
          @click="closeMobileMenu"
        >
          <span class="nav-index" aria-hidden="true">01</span>
          {{ t('toolbar.systems') }}
          <span class="nav-arrow" aria-hidden="true">↗</span>
        </NuxtLinkLocale>
        <NuxtLinkLocale
          :to="{ path: '/', hash: '#build' }"
          @click="closeMobileMenu"
        >
          <span class="nav-index" aria-hidden="true">02</span>
          {{ t('toolbar.build') }}
          <span class="nav-arrow" aria-hidden="true">↗</span>
        </NuxtLinkLocale>
        <NuxtLinkLocale
          :to="{ path: '/', hash: '#about' }"
          @click="closeMobileMenu"
        >
          <span class="nav-index" aria-hidden="true">03</span>
          {{ t('toolbar.about') }}
          <span class="nav-arrow" aria-hidden="true">↗</span>
        </NuxtLinkLocale>
        <NuxtLinkLocale
          :to="{ path: '/', hash: '#contact' }"
          @click="closeMobileMenu"
        >
          <span class="nav-index" aria-hidden="true">04</span>
          {{ t('toolbar.contact') }}
          <span class="nav-arrow" aria-hidden="true">↗</span>
        </NuxtLinkLocale>
      </nav>

      <div class="mobile-preferences">
        <div class="preference-row">
          <p class="preference-label">
            {{ t('toolbar.language') }}
          </p>
          <LanguageSwitch show-full-labels />
        </div>
        <div class="preference-row">
          <p class="preference-label">
            {{ t('toolbar.theme.group') }}
          </p>
          <div
            class="appearance-options"
            role="group"
            :aria-label="themeLabels.group"
          >
            <button
              v-for="option in mobileThemes"
              :key="option.value"
              type="button"
              class="appearance-option"
              :class="{ 'appearance-option--active': preference === option.value }"
              :aria-pressed="preference === option.value"
              @click="preference = option.value"
            >
              <span class="appearance-symbol" aria-hidden="true">{{ option.icon }}</span>
              <span class="appearance-caption">{{ option.label }}</span>
              <span class="appearance-dot" aria-hidden="true" />
            </button>
          </div>
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

/* Editorial mobile settings rather than stretched desktop segmented controls. */
@media (max-width: 850px) {
  .mobile-panel {
    width: min(390px, calc(100vw - 24px));
    padding: clamp(16px, 4vw, 24px);
    border-color: rgb(123 181 244 / 48%);
    border-radius: 18px;
    background:
      radial-gradient(circle at 88% -10%, rgb(31 108 218 / 20%), transparent 43%),
      #0a1728;
  }
  .mobile-menu-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 0 6px 13px;
    color: #93cef5;
    font: 700 10px/1.5 var(--lb-font-mono);
    text-transform: uppercase;
    letter-spacing: .13em;
  }
  .menu-heading-mark {
    color: #7b99b8;
    font-weight: 500;
  }
  .mobile-nav {
    gap: 5px;
  }
  .mobile-nav a {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr) 20px;
    gap: 12px;
    min-height: 54px;
    padding: 11px 13px;
    border: 1px solid transparent;
    border-radius: 9px;
    font-size: 15px;
    font-weight: 700;
  }
  .mobile-nav a:hover,
  .mobile-nav a:focus-visible {
    border-color: #355579;
  }
  .nav-index {
    color: #76b9eb;
    font: 500 10px var(--lb-font-mono);
  }
  .nav-arrow {
    justify-self: end;
    color: #8bdcff;
    font-size: 16px;
  }
  .mobile-preferences {
    gap: 24px;
    margin-top: 18px;
    padding-top: 22px;
    border-top-color: rgb(125 171 229 / 28%);
  }
  .preference-row {
    gap: 12px;
  }
  .preference-label {
    color: #91bddf;
    font-size: 10px;
    letter-spacing: .11em;
  }
  .mobile-preferences :deep(.langs--expanded) {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    width: 100%;
    gap: 10px;
    border: 0;
    border-radius: 0;
    overflow: visible;
  }
  .mobile-preferences :deep(.lang--expanded) {
    display: flex;
    flex-direction: column;
    gap: 4px;
    justify-content: center;
    min-width: 0;
    min-height: 67px;
    padding: 9px;
    border: 1px solid #395777;
    border-radius: 10px;
    background: #112239;
    color: #d8eafa;
    transition: border-color 180ms ease, background 180ms ease;
  }
  .mobile-preferences :deep(.lang--expanded + .lang--expanded) {
    border: 1px solid #395777;
  }
  .mobile-preferences :deep(.lang--expanded[aria-current="true"]) {
    border-color: #8ddcff;
    background: #143554;
    color: #e5f6ff;
    box-shadow: inset 0 0 0 1px rgb(139 217 255 / 24%);
  }
  .mobile-preferences :deep(.lang-short) {
    font: 800 17px/1.1 var(--lb-font-sans);
    letter-spacing: .03em;
  }
  .mobile-preferences :deep(.lang-full) {
    font: 500 11px/1.2 var(--lb-font-sans);
    letter-spacing: 0;
    color: #a7c3df;
  }
  .appearance-options {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  .appearance-option {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    position: relative;
    min-width: 0;
    min-height: 84px;
    padding: 11px 5px;
    color: #b6cee7;
    border: 1px solid #395777;
    border-radius: 10px;
    background: #112239;
    cursor: pointer;
    transition: background 180ms ease, border-color 180ms ease;
  }
  .appearance-option:hover {
    border-color: #83caff;
    background: #163151;
  }
  .appearance-option--active {
    color: #e9f7ff;
    border-color: #8ddcff;
    background: #153555;
    box-shadow: inset 0 0 0 1px rgb(139 217 255 / 24%);
  }
  .appearance-option:focus-visible {
    outline: 2px solid #abecff;
    outline-offset: 3px;
  }
  .appearance-symbol {
    font-size: 25px;
    line-height: 1;
    font-family: var(--lb-font-sans);
  }
  .appearance-caption {
    font: 600 11px/1.25 var(--lb-font-sans);
    text-align: center;
  }
  .appearance-dot {
    position: absolute;
    top: 9px;
    right: 9px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: transparent;
  }
  .appearance-option--active .appearance-dot {
    background: #8ee7ff;
    box-shadow: 0 0 10px #3cafff;
  }
}
@media (prefers-reduced-motion: reduce) {
  .appearance-option,
  .mobile-preferences :deep(.lang--expanded) {
    transition: none;
  }
}

</style>
