// Types shared by the generated registry and the Vue component.

/** One path of an icon: its shape, and how it is painted. */
export interface IconPath {
  /** Absolute path data on the 24-unit grid. */
  readonly d: string
  /** Painted in the accent colour (the logo's ribbon blue) instead of currentColor. */
  readonly accent: boolean
  /** Filled instead of stroked. */
  readonly fill: boolean
}
