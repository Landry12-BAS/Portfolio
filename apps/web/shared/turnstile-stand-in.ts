// The one stand-in for a Turnstile token that the end-to-end test build accepts, so the journeys
// can pass the gate without Cloudflare. It is read only behind `__LB_TEST_BUILD__`, which the
// production build replaces with `false`, so this text is not in a production bundle:
// `scripts/check-production-build.ts` fails CI if it is. Nothing here is a secret, and it opens
// nothing in a production build, which doesn't contain the code that would accept it.

/** The token the test build's browser sends, and its server accepts, in place of a Turnstile token. */
export const TEST_TURNSTILE_STAND_IN = 'lb-test-turnstile-stand-in'
