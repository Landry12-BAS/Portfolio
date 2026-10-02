// What the page and the server must agree on about LB-02's installable board: the service worker's
// address and the name of the Trusted Types policy that makes it, and the two pages (one for each
// language) whose Content Security Policy is the only one that grows because of it. Both sides import
// these, so the policy the page asks for and the policy the server allows cannot drift apart.

/** The service worker's address, the only script address its Trusted Types policy hands out. */
export const SERVICE_WORKER_URL = '/lb02-sw.js'

/** The name of the Trusted Types policy that makes the service worker's address. It is never `default`. */
export const SERVICE_WORKER_POLICY = 'lb-service-worker'

/** The pages of LB-02's board, in English and in Czech. */
export const BOARD_PAGE_ROUTES = ['/systems/lb-02/board', '/cs/systems/lb-02/board'] as const
