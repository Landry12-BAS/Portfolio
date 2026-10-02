// Draws charts with the board's own Vega code, headless, in a Node process that has V8's code
// generation from strings switched off (`node --disallow-code-generation-from-strings`): `eval` and
// `new Function` both throw there, exactly as the site's Content Security Policy makes the browser
// refuse them. The test that starts this script (test/unit/lb05-chart-render.test.ts) hands it the
// tokens and charts as JSON on standard input and reads back what was drawn, as SVG text. If Vega
// needed to compile an expression with the Function constructor, drawing would fail here.
import { readFileSync } from 'node:fs'

import { createView } from '../../app/boards/lb-05/chart/render.ts'
import type { ChartSpec } from '../../app/boards/lb-05/chart/spec.ts'
import type { ChartTokens } from '../../app/boards/lb-05/chart/theme.ts'

/** What the test hands over. */
interface Input {
  tokens: ChartTokens
  charts: ChartSpec[]
  width: number
}

/** What was drawn, in the few numbers the test checks. */
interface Drawn {
  svg: string
}

/** Tells whether the Function constructor is switched off, which is the point of running here. */
function codeGenerationIsOff(): boolean {
  try {
    // This is the one place the repository calls the Function constructor, to prove it is refused.
    // eslint-disable-next-line no-new-func
    new Function('return 1')()
    return false
  }
  catch (error) {
    return error instanceof EvalError
  }
}

/** Draws one chart headless and returns it as SVG. */
async function draw(spec: ChartSpec, tokens: ChartTokens, width: number): Promise<Drawn> {
  const view = createView(spec, tokens, width, 'none')
  await view.runAsync()
  const svg = await view.toSVG()
  view.finalize()
  return { svg }
}

const input = JSON.parse(readFileSync(0, 'utf8')) as Input
const drawn: Drawn[] = []
for (const chart of input.charts) drawn.push(await draw(chart, input.tokens, input.width))
console.log(JSON.stringify({ codeGenerationIsOff: codeGenerationIsOff(), drawn }))
