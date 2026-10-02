// Tests of `scripts/check-production-build.ts`, the guard CI relies on to keep the test build's
// stand-in for a Turnstile token out of a production bundle. A guard that passes when it looked at
// nothing is worse than none, so these tests run the real script on small folders that stand for a
// clean build, a build with the stand-in, an empty one and a missing one, in both directions.
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const run = promisify(execFile)
const SCRIPT = join(import.meta.dirname, '../../scripts/check-production-build.ts')

let scratch: string

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lb-check-build-'))
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** Makes a folder holding one file in a subfolder, as a build does, and returns its path. */
function build(name: string, file: string, text: string): string {
  const folder = join(scratch, name)
  mkdirSync(join(folder, 'public/_nuxt'), { recursive: true })
  writeFileSync(join(folder, 'public/_nuxt', file), text)
  return folder
}

/** Runs the script and returns its exit status and what it said. */
async function check(...args: string[]): Promise<{ status: number, said: string }> {
  try {
    const { stdout, stderr } = await run('node', [SCRIPT, ...args])
    return { status: 0, said: stdout + stderr }
  }
  catch (error) {
    const failure = error as { code: number, stdout: string, stderr: string }
    return { status: failure.code, said: failure.stdout + failure.stderr }
  }
}

describe('the production build check', () => {
  it('passes a build with no trace of the stand-in', async () => {
    const clean = build('clean', 'app.js', 'console.log("a production build")')

    const result = await check(clean)

    expect(result.status).toBe(0)
    expect(result.said).toContain('no trace of the test build')
  })

  it('fails a build that holds the stand-in token, or the flag that guards it, and names the file', async () => {
    const token = build('with-token', 'app.js', 'const t = "lb-test-turnstile-stand-in"')
    const flag = build('with-flag', 'app.js', 'if (__LB_TEST_BUILD__) accept()')

    const withToken = await check(token)
    const withFlag = await check(flag)

    expect(withToken.status).toBe(1)
    expect(withToken.said).toContain('public/_nuxt/app.js contains lb-test-turnstile-stand-in')
    expect(withFlag.status).toBe(1)
    expect(withFlag.said).toContain('contains __LB_TEST_BUILD__')
  })

  it('is not fooled by a folder with nothing in it, or by no folder: it has looked at nothing, which is neither', async () => {
    const empty = join(scratch, 'empty')
    mkdirSync(empty)

    expect((await check(empty)).status).toBe(2)
    expect((await check(join(scratch, 'does-not-exist'))).status).toBe(2)
    expect((await check(empty, '--expect-test-code')).status).toBe(2)
  })
})

describe('the same check, turned round for the test build', () => {
  it('passes only when the test build\'s code is there', async () => {
    const testBuild = build('test-build', 'app.js', 'const t = "lb-test-turnstile-stand-in"')
    const clean = build('not-a-test-build', 'app.js', 'console.log("no stand-in here")')

    const found = await check(testBuild, '--expect-test-code')
    const missing = await check(clean, '--expect-test-code')

    expect(found.status).toBe(0)
    expect(found.said).toContain('the check finds it')
    expect(missing.status).toBe(1)
    expect(missing.said).toContain('would not see one in a build that has it')
  })
})
