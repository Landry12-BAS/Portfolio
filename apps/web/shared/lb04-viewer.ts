// What the server and LB-04's PDF viewer both need to agree on: the name of the one Trusted Types policy
// that hands out the address of pdf.js's worker, and the pages the viewer runs on. The server adds the
// policy's name, and the worker source, to the Content Security Policy of those two pages and no others
// (server/lib/lb04-csp.ts), and the viewer registers a policy of exactly that name (app/boards/lb-04/pdf).

/** The name of the Trusted Types policy that makes the worker's address. It is never `default`. */
export const PDF_WORKER_POLICY = 'lb-pdf-worker'

/** The pages of LB-04's board, in English and in Czech. */
export const LB04_BOARD_PAGE_ROUTES = ['/systems/lb-04/board', '/cs/systems/lb-04/board'] as const
