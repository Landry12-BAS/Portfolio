// What kind of build the site is, and where it may be one. The end-to-end test build
// (`LB_TEST_BUILD=1`, `pnpm --filter @lb/web build:e2e`) accepts a fixed stand-in for a Turnstile token
// and bundles recordings made on the mock, so it must never be the production site. CI proves that its own
// production bundle holds no trace of the stand-in (`just check-build`), but it cannot see a build made on
// Vercel, where `LB_TEST_BUILD=1` left in the project's environment would compile the stand-in in. So the
// build refuses that variable where VERCEL is set (nuxt.config.ts), and a server that was built as a test
// build refuses to start there (server/lib/config.ts). Both read this file, so they agree.

/** The environment variables a build or a server is given: `process.env` fits. Two of them matter here, LB_TEST_BUILD and VERCEL. */
export type ModeEnvironment = Readonly<Record<string, string | undefined>>

/** Why a test build is refused on Vercel, for the person who set the variable. It names the variables and never a value. */
export const TEST_BUILD_ON_VERCEL = 'LB_TEST_BUILD=1 is set where VERCEL is set: the end-to-end test build accepts a stand-in for Turnstile and must never be the production site. Remove LB_TEST_BUILD from the Vercel project\'s environment.'

/** Tells whether the environment is Vercel's: it sets VERCEL on its builds and on the servers it runs. */
export function isOnVercel(environment: ModeEnvironment): boolean {
  return (environment.VERCEL ?? '') !== ''
}

/** Throws when a test build is asked for, or running, on Vercel. */
export function refuseTestBuildOnVercel(testBuild: boolean, environment: ModeEnvironment): void {
  if (testBuild && isOnVercel(environment)) throw new Error(TEST_BUILD_ON_VERCEL)
}

/** Tells whether this is the end-to-end test build: only `LB_TEST_BUILD=1` makes it one, and never where VERCEL is set. */
export function isTestBuild(environment: ModeEnvironment): boolean {
  const testBuild = environment.LB_TEST_BUILD === '1'
  refuseTestBuildOnVercel(testBuild, environment)
  return testBuild
}
