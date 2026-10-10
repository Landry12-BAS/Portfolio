// Tests for what kind of build the site is: the end-to-end test build, which accepts a fixed stand-in for a
// Turnstile token, is refused wherever the production site is built or runs (Vercel), at build time by the
// build's own configuration and at run time by the server's settings. CI's check of the production bundle
// cannot see a build made on Vercel, so these two refusals are what keep the stand-in out of it.
import { describe, expect, it } from 'vitest'

import { isOnVercel, isTestBuild, refuseTestBuildOnVercel, TEST_BUILD_ON_VERCEL } from '../../shared/build-mode.ts'

describe('isTestBuild', () => {
  it('is true only when LB_TEST_BUILD is exactly 1', () => {
    expect(isTestBuild({ LB_TEST_BUILD: '1' })).toBe(true)
    expect(isTestBuild({})).toBe(false)
    expect(isTestBuild({ LB_TEST_BUILD: '' })).toBe(false)
    expect(isTestBuild({ LB_TEST_BUILD: '0' })).toBe(false)
    expect(isTestBuild({ LB_TEST_BUILD: 'true' })).toBe(false)
  })

  it('leaves a build on Vercel alone when it is a production build', () => {
    expect(isTestBuild({ VERCEL: '1' })).toBe(false)
    expect(isTestBuild({ VERCEL: '1', LB_TEST_BUILD: '0' })).toBe(false)
  })

  it('refuses to be a test build where VERCEL is set, however it is set', () => {
    expect(() => isTestBuild({ LB_TEST_BUILD: '1', VERCEL: '1' })).toThrow(TEST_BUILD_ON_VERCEL)
    expect(() => isTestBuild({ LB_TEST_BUILD: '1', VERCEL: 'anything' })).toThrow(TEST_BUILD_ON_VERCEL)
  })
})

describe('isOnVercel', () => {
  it('is true for any value of VERCEL, and false for none or an empty one', () => {
    expect(isOnVercel({ VERCEL: '1' })).toBe(true)
    expect(isOnVercel({ VERCEL: '0' })).toBe(true)
    expect(isOnVercel({ VERCEL: '' })).toBe(false)
    expect(isOnVercel({})).toBe(false)
  })
})

describe('refuseTestBuildOnVercel', () => {
  it('refuses the test build on Vercel, and nothing else', () => {
    expect(() => refuseTestBuildOnVercel(true, { VERCEL: '1' })).toThrow(TEST_BUILD_ON_VERCEL)
    expect(() => refuseTestBuildOnVercel(true, {})).not.toThrow()
    expect(() => refuseTestBuildOnVercel(false, { VERCEL: '1' })).not.toThrow()
    expect(() => refuseTestBuildOnVercel(false, {})).not.toThrow()
  })

  it('says what to do, and names the variables without repeating a value', () => {
    expect(TEST_BUILD_ON_VERCEL).toContain('LB_TEST_BUILD')
    expect(TEST_BUILD_ON_VERCEL).toContain('VERCEL')
    expect(TEST_BUILD_ON_VERCEL.toLowerCase()).toContain('remove')
  })
})
