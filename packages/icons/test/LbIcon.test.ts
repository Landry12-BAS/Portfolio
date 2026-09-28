// Tests for <LbIcon>: accessible naming, sizing, and the duo and mono tones.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { icons, LbIcon } from '../src'

describe('LbIcon', () => {
  it('is decorative when it has no label', () => {
    const svg = mount(LbIcon, { props: { name: 'check' } }).get('svg')
    expect(svg.attributes('aria-hidden')).toBe('true')
    expect(svg.attributes('role')).toBeUndefined()
    expect(svg.attributes('aria-label')).toBeUndefined()
  })

  it('is an image named by its label', () => {
    const svg = mount(LbIcon, { props: { name: 'check', label: 'Copied' } }).get('svg')
    expect(svg.attributes('role')).toBe('img')
    expect(svg.attributes('aria-label')).toBe('Copied')
    expect(svg.attributes('aria-hidden')).toBeUndefined()
  })

  it('draws every path of the icon and marks the accent', () => {
    const wrapper = mount(LbIcon, { props: { name: 'upload' } })
    expect(wrapper.findAll('path')).toHaveLength(icons.upload.length)
    expect(wrapper.findAll('path.lb-icon__accent')).toHaveLength(icons.upload.filter(p => p.accent).length)
  })

  it('fills filled paths instead of stroking them', () => {
    const dot = mount(LbIcon, { props: { name: 'info' } }).findAll('path').at(-1)
    expect(dot?.attributes('fill')).toBe('currentColor')
    expect(dot?.attributes('stroke')).toBe('none')
  })

  it('paints the accent in currentColor in the mono tone', () => {
    const svg = mount(LbIcon, { props: { name: 'check', tone: 'mono' } }).get('svg')
    expect(svg.classes()).toContain('lb-icon--mono')
  })

  it('accepts a pixel size or any CSS length', () => {
    expect(mount(LbIcon, { props: { name: 'check', size: 32 } }).get('svg').attributes('width')).toBe('32')
    expect(mount(LbIcon, { props: { name: 'check', size: '1.5em' } }).get('svg').attributes('height')).toBe('1.5em')
  })
})
