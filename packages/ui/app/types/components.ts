// Types shared by the design system's components.
import type { IconName } from '@lb/icons'

/** One button of a segmented control (<LbSegmented>): the value it selects and how it looks. */
export interface SegmentOption<V extends string> {
  value: V
  label: string
  /** Shown before the label, or instead of it when `iconOnly` is set. */
  icon?: IconName
  /** Hide the text; the label still names the button for assistive tech. */
  iconOnly?: boolean
}

/** One row of a spec table (<LbSpecTable>): a parameter and its value. */
export interface SpecRow {
  label: string
  value: string
}

/** The visitor's theme choice; `system` follows the operating system's setting. */
export type ColorPreference = 'light' | 'dark' | 'system'

/** The theme toggle's text, in the page's language: the group's name and each button's. */
export interface ThemeToggleLabels {
  group: string
  light: string
  dark: string
  system: string
}
