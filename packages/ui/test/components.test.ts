// Tests for the design system's base components: logo, segmented control, theme
// toggle, spec table, section heading and pill.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import LbLogo from '../app/components/LbLogo.vue'
import LbPill from '../app/components/LbPill.vue'
import LbSectionHead from '../app/components/LbSectionHead.vue'
import LbSegmented from '../app/components/LbSegmented.vue'
import LbSpecTable from '../app/components/LbSpecTable.vue'
import LbThemeToggle from '../app/components/LbThemeToggle.vue'

/**
 * Returns what an <img> source points at: the brand file's path, or, when Vite inlined
 * the small SVG as a data URL, the file's own content.
 */
function brandSource(src: string | undefined): string {
  if (!src?.startsWith('data:image/svg+xml;base64,')) return src ?? ''
  return Buffer.from(src.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8')
}

describe('LbLogo', () => {
  it('loads both brand files so the theme can pick one without script', () => {
    const [light, dark] = mount(LbLogo).findAll('img').map(img => brandSource(img.attributes('src')))
    expect(light).toMatch(/lb-mark-light\.svg|Light theme: ink letters, blue ribbon/)
    expect(dark).toMatch(/lb-mark-dark\.svg|Dark theme: brushed silver letters, blue ribbon/)
  })

  it('keeps the mark in proportion and names it', () => {
    const img = mount(LbLogo, { props: { height: 40 } }).get('img')
    expect(img.attributes('height')).toBe('40')
    expect(img.attributes('width')).toBe('49.8')
    expect(img.attributes('alt')).toBe('LB, Landry Bodjona')
  })

  it('can be decorative when a wordmark sits beside it', () => {
    const imgs = mount(LbLogo, { props: { label: '' } }).findAll('img')
    expect(imgs.every(img => img.attributes('alt') === '')).toBe(true)
  })
})

describe('LbSegmented', () => {
  const options = [
    { value: 'technical' as const, label: 'Technical' },
    { value: 'brief' as const, label: 'Brief' },
  ]

  it('marks exactly the selected option as pressed', () => {
    const buttons = mount(LbSegmented, { props: { options, label: 'Reading mode', modelValue: 'brief' } })
      .findAll('button')
    expect(buttons.map(b => b.attributes('aria-pressed'))).toEqual(['false', 'true'])
  })

  it('reports the chosen option through v-model', async () => {
    const wrapper = mount(LbSegmented, { props: { options, label: 'Reading mode', modelValue: 'technical' } })
    await wrapper.findAll('button')[1]?.trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([['brief']])
  })

  it('names the group', () => {
    const group = mount(LbSegmented, { props: { options, label: 'Reading mode', modelValue: 'technical' } })
      .get('[role="group"]')
    expect(group.attributes('aria-label')).toBe('Reading mode')
  })
})

describe('LbThemeToggle', () => {
  it('offers light, dark and the system setting, with icon buttons named for screen readers', () => {
    const buttons = mount(LbThemeToggle, { props: { modelValue: 'system' } }).findAll('button')
    expect(buttons.map(b => b.attributes('aria-label') ?? b.text())).toEqual(['Light theme', 'Dark theme', 'Auto'])
    expect(buttons[2]?.attributes('aria-pressed')).toBe('true')
  })

  it('speaks the page\'s language when given its labels', () => {
    const labels = { group: 'Motiv', light: 'Světlý motiv', dark: 'Tmavý motiv', system: 'Auto' }
    const wrapper = mount(LbThemeToggle, { props: { modelValue: 'dark', labels } })
    expect(wrapper.get('[role="group"]').attributes('aria-label')).toBe('Motiv')
    expect(wrapper.findAll('button').map(b => b.attributes('aria-label') ?? b.text())).toEqual(['Světlý motiv', 'Tmavý motiv', 'Auto'])
  })

  it('switches to dark', async () => {
    const wrapper = mount(LbThemeToggle, { props: { modelValue: 'light' } })
    await wrapper.findAll('button')[1]?.trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([['dark']])
  })
})

describe('LbSpecTable', () => {
  it('renders each parameter as a row header with its value', () => {
    const wrapper = mount(LbSpecTable, {
      props: {
        caption: 'Operating limits',
        columns: ['Operating limit', 'Value'],
        rows: [{ label: 'Tickets per visitor per day', value: '20' }, { label: 'Visitor data kept', value: '24 h' }],
      },
    })
    expect(wrapper.get('caption').text()).toBe('Operating limits')
    expect(wrapper.findAll('tbody th[scope="row"]').map(th => th.text()))
      .toEqual(['Tickets per visitor per day', 'Visitor data kept'])
    expect(wrapper.findAll('tbody td').map(td => td.text())).toEqual(['20', '24 h'])
  })
})

describe('LbSectionHead and LbPill', () => {
  it('uses the requested heading level', () => {
    const wrapper = mount(LbSectionHead, { props: { num: 4, title: 'Selection guide', level: 3 } })
    expect(wrapper.get('h3').text()).toBe('Selection guide')
  })

  it('renders the pill variant', () => {
    const wrapper = mount(LbPill, { props: { variant: 'solid' }, slots: { default: 'Phase 1' } })
    expect(wrapper.classes()).toContain('lb-pill--solid')
    expect(wrapper.text()).toBe('Phase 1')
  })
})
