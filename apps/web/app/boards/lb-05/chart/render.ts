// Draws an accepted chart on a canvas with Vega, in a way the site's Content Security Policy allows:
// no `eval` and no `new Function` anywhere. Vega compiles the expressions of a spec to JavaScript with
// the Function constructor unless it is given an interpreter, so the spec is parsed with its syntax
// trees kept (`ast: true`) and the view is handed `vega-interpreter`, which walks the trees instead.
// The view gets a loader that refuses everything, so nothing a spec says can fetch a file or a page;
// no tooltip handler is installed, so no HTML is ever made; and the canvas renderer draws text and
// shapes into pixels, never into markup. This module is the only one that imports Vega, and the
// chart view loads it with `import()` when a chart is first drawn, so the catalog and every page that
// shows no chart never download it. (Its imports name their files with `.ts`, so Node can run it as it
// is: the test that proves it never needs `eval` does exactly that, with V8's code generation off.)
import * as vega from 'vega'
import { expressionInterpreter } from 'vega-interpreter'
import { compile } from 'vega-lite'
import type { TopLevelSpec } from 'vega-lite'

import { vegaLocale } from './locale.ts'
import type { ChartLanguage } from './locale.ts'
import type { ChartSpec } from './spec.ts'
import { chartConfig } from './theme.ts'
import type { ChartTokens, LabelLayout } from './theme.ts'

/** The narrowest a chart is drawn, so labels stay legible however small the box is. */
export const MIN_CHART_WIDTH = 240

/** A chart on the page. */
export interface DrawnChart {
  // Draws the chart again at a new width.
  resize: (width: number) => Promise<void>
  // Takes the chart off the page and lets go of what it holds.
  destroy: () => void
}

/** Turns away a request to load anything: a chart is made of the data written into its spec. */
function refuseToLoad(): Promise<never> {
  return Promise.reject(new Error('A chart does not load anything.'))
}

/** A loader that loads nothing, for a view that must not reach out to a file or an address. */
const REFUSING_LOADER: vega.Loader = {
  load: refuseToLoad,
  sanitize: refuseToLoad,
  http: refuseToLoad,
  file: refuseToLoad,
}

/** Keeps a width in pixels to what a chart can be drawn at. */
function clampWidth(width: number): number {
  return Math.max(Math.round(width), MIN_CHART_WIDTH)
}

/**
 * Writes the Vega-Lite spec to compile from an accepted chart: the same chart, at a width in pixels
 * (the spec says "container", which would need Vega to measure the page), and with its tooltip off.
 */
function specToCompile(spec: ChartSpec, width: number): TopLevelSpec {
  return {
    $schema: spec.$schema,
    description: spec.description,
    data: { values: spec.data.values },
    mark: { type: spec.mark.type, tooltip: false },
    encoding: spec.encoding,
    width: clampWidth(width),
    height: spec.height,
    autosize: { type: 'fit', contains: 'padding' },
  }
}

/** The most categories a chart's horizontal axis names flat; with more, the names are tilted so that every one is shown. */
const MOST_FLAT_LABELS = 4

/** Chooses how the labels along the horizontal axis are set: tilted when it names many categories, which flat labels would crowd out. */
function labelLayout(spec: ChartSpec): LabelLayout {
  const names = spec.encoding.x.type === 'nominal' || spec.encoding.x.type === 'ordinal'
  return names && new Set(spec.data.values.map(point => point.x)).size > MOST_FLAT_LABELS ? 'tilted' : 'flat'
}

/** Compiles a chart to the Vega spec that draws it, dressed in the tokens and following the language's number and date conventions. */
export function compileChart(spec: ChartSpec, tokens: ChartTokens, width: number, language: ChartLanguage = 'en'): vega.Spec {
  const compiled = compile(specToCompile(spec, width), { config: chartConfig(tokens, labelLayout(spec)) }).spec
  const locale = vegaLocale(language)
  return locale ? { ...compiled, config: { ...compiled.config, locale } } : compiled
}

/**
 * Makes the Vega view of a chart: parsed with its expressions' syntax trees kept, evaluated by the
 * interpreter, unable to load anything. The renderer is `canvas` for a page (with the container to draw
 * in) and `none` for a test that reads the drawing back as SVG.
 */
export function createView(spec: ChartSpec, tokens: ChartTokens, width: number, renderer: 'canvas' | 'none', container?: HTMLElement, language: ChartLanguage = 'en'): vega.View {
  const runtime = vega.parse(compileChart(spec, tokens, width, language), undefined, { ast: true })
  return new vega.View(runtime, { expr: expressionInterpreter, renderer, container, loader: REFUSING_LOADER, hover: false })
}

/** Draws a chart into a container on a canvas, and keeps it ready to be drawn again at another width. */
export async function drawChart(container: HTMLElement, spec: ChartSpec, tokens: ChartTokens, width: number, language: ChartLanguage = 'en'): Promise<DrawnChart> {
  const view = createView(spec, tokens, width, 'canvas', container, language)
  await view.runAsync()
  return {
    resize: async (next) => {
      view.width(clampWidth(next))
      await view.runAsync()
    },
    destroy: () => {
      view.finalize()
      container.replaceChildren()
    },
  }
}
