import type { IconName } from '@lb/icons'

export interface SegmentOption<V extends string> {
  value: V
  label: string
  /** Shown before the label, or instead of it when `iconOnly` is set. */
  icon?: IconName
  /** Hide the text; the label still names the button for assistive tech. */
  iconOnly?: boolean
}

export interface SpecRow {
  label: string
  value: string
}

export type ColorPreference = 'light' | 'dark' | 'system'
