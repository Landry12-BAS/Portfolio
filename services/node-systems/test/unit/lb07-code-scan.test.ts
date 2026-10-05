// A tripwire for LB-07's central promise: the service never runs what a model, a page or a visitor wrote. Every
// source file of the module and the sandbox process is read as text, and none may evaluate a string as code
// (`eval`, `new Function`, a `vm` script, a string given to a timer), start a process, or import a module by a
// path made at run time (the generated test is text the service shows; it is never written to a file it loads).
// It is a tripwire for the future, not a proof: the README's threat model says what else holds the line.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../src/', import.meta.url))

/** Lists every TypeScript file under a folder, with its path from the source root. */
function filesUnder(folder: string): string[] {
  return readdirSync(`${ROOT}${folder}`).flatMap((name) => {
    const path = `${folder}/${name}`
    if (statSync(`${ROOT}${path}`).isDirectory()) return filesUnder(path)
    return name.endsWith('.ts') ? [path] : []
  })
}

// LB-07's module and the process that drives the browser.
const FILES = [...filesUnder('modules/lb07'), 'sandbox.ts']

// Modules that run text as code or start a process.
const FORBIDDEN_MODULES = ['node:vm', 'vm', 'node:child_process', 'child_process', 'node:worker_threads', 'worker_threads', 'node:cluster', 'cluster', 'node:repl', 'node:inspector']

// What does the same without an import: evaluating a string, a function made from one, a timer given a string, a module loaded by a path made at run time.
const FORBIDDEN_CODE = [/\beval\s*\(/, /\bnew\s+Function\b/, /\bFunction\s*\(/, /\bset(?:Timeout|Interval|Immediate)\s*\(\s*['"`]/, /\bimport\s*\(/, /\brequire\s*\(/, /\bprocess\.(?:binding|dlopen)\b/, /\bexecSync\b|\bspawn\s*\(|\bexecFile\b/]

/** A file's code without its comments, line by line: what the scan reads. */
function codeOf(path: string): string {
  return readFileSync(`${ROOT}${path}`, 'utf8')
    .split('\n')
    .filter(line => !/^\s*(?:\/\/|\*|\/\*\*)/.test(line))
    .map(line => line.replace(/\s\/\/ .*$/, ''))
    .join('\n')
}

/** The modules a file imports. */
function importsOf(path: string): string[] {
  return [...readFileSync(`${ROOT}${path}`, 'utf8').matchAll(/\bfrom '([^']+)'/g)].map(match => match[1] ?? '')
}

describe('LB-07 runs nothing it was given', () => {
  it('reads every file of the module and the sandbox process', () => {
    expect(FILES.length).toBeGreaterThan(40)
    expect(FILES).toContain('modules/lb07/agent/testgen.ts')
    expect(FILES).toContain('modules/lb07/runner/session.ts')
  })

  it.each(FILES)('%s imports nothing that runs text as code or starts a process', (path) => {
    expect(importsOf(path).filter(module => FORBIDDEN_MODULES.includes(module))).toEqual([])
  })

  it.each(FILES)('%s evaluates no string, makes no function from one, and loads no module by a path made at run time', (path) => {
    const code = codeOf(path)
    for (const pattern of FORBIDDEN_CODE) expect(code, String(pattern)).not.toMatch(pattern)
  })

  it('catches what it looks for: the patterns find each forbidden form', () => {
    const forms = ['eval(text)', 'new Function(text)', 'Function(\'return 1\')', 'setTimeout(\'evil()\', 1)', 'await import(path)', 'require(name)', 'execSync(command)', 'spawn(\'sh\')']
    for (const form of forms) expect(FORBIDDEN_CODE.some(pattern => pattern.test(form)), form).toBe(true)
    // What the module does use and must not be mistaken for them: Playwright's page.evaluate and createRequire's resolve.
    for (const allowed of ['page.evaluate(source)', 'createRequire(import.meta.url).resolve(\'axe-core/axe.min.js\')']) {
      expect(FORBIDDEN_CODE.some(pattern => pattern.test(allowed)), allowed).toBe(false)
    }
  })
})
