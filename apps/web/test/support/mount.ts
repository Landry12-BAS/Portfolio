// Mounting components for tests the way the site runs them, without a Nuxt runtime: the real
// messages in English or Czech through vue-i18n, a fresh Pinia, the design system's components
// and the evaluation-board kit registered under the names Nuxt would give them, and plain
// stand-ins for the router's links. What the components do is real; only the wiring is the test's.
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Pinia } from 'pinia'
import { defineComponent, h } from 'vue'
import type { Component } from 'vue'
import { createI18n } from 'vue-i18n'

import LbPill from '../../../../packages/ui/app/components/LbPill.vue'
import LbSectionHead from '../../../../packages/ui/app/components/LbSectionHead.vue'
import LbSegmented from '../../../../packages/ui/app/components/LbSegmented.vue'
import LbSpecTable from '../../../../packages/ui/app/components/LbSpecTable.vue'
import BoardLimitsPanel from '../../app/components/board/LimitsPanel.vue'
import BoardNotice from '../../app/components/board/Notice.vue'
import BoardReplayBanner from '../../app/components/board/ReplayBanner.vue'
import BoardSamplePicker from '../../app/components/board/SamplePicker.vue'
import BoardScopePanel from '../../app/components/board/ScopePanel.vue'
import BoardShell from '../../app/components/board/Shell.vue'
import BoardTurnstileGate from '../../app/components/board/TurnstileGate.vue'
import ReadingModeSwitch from '../../app/components/ReadingModeSwitch.vue'
import cs from '../../i18n/locales/cs'
import en from '../../i18n/locales/en'

/** A link as the router would draw it: an anchor to the path it was given. */
const LinkStandIn = defineComponent({
  props: { to: { type: [String, Object], required: true } },
  setup(props, { slots }) {
    return () => h('a', { href: typeof props.to === 'string' ? props.to : (props.to as { path: string }).path }, slots.default?.())
  },
})

/** The components every page and board may use without importing them, as Nuxt registers them. */
const GLOBAL_COMPONENTS: Record<string, Component> = {
  LbPill,
  LbSectionHead,
  LbSegmented,
  LbSpecTable,
  BoardLimitsPanel,
  BoardNotice,
  BoardReplayBanner,
  BoardSamplePicker,
  BoardScopePanel,
  BoardShell,
  BoardTurnstileGate,
  ReadingModeSwitch,
  NuxtLink: LinkStandIn,
  NuxtLinkLocale: LinkStandIn,
}

/** What a test may choose when it mounts a component. */
export interface MountOptions {
  locale?: 'en' | 'cs'
  props?: Record<string, unknown>
  // Pass the Pinia of an earlier mount to mount again with the stores as that left them, as a visitor
  // who comes back to a page finds them (the stores outlive the page).
  pinia?: Pinia
}

/** Mounts a component with the site's messages, a fresh Pinia and the kit registered. */
export function mountWithSite(component: Component, options: MountOptions = {}): VueWrapper {
  const pinia = options.pinia ?? createPinia()
  setActivePinia(pinia)
  const i18n = createI18n({ legacy: false, locale: options.locale ?? 'en', fallbackLocale: 'en', messages: { en, cs } })
  return mount(component, {
    props: options.props,
    global: { plugins: [pinia, i18n], components: GLOBAL_COMPONENTS },
    attachTo: document.body,
  })
}
