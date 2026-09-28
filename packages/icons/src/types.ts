export interface IconPath {
  /** Absolute path data on the 24-unit grid. */
  readonly d: string
  /** Painted in the accent colour (the logo's ribbon blue) instead of currentColor. */
  readonly accent: boolean
  /** Filled instead of stroked. */
  readonly fill: boolean
}
