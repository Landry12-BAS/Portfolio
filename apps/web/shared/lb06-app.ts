// What the page and the server must agree on about LB-06's board: the two pages (one for each
// language) whose Content Security Policy is the only one that grows because of its WebSocket, and
// the path the socket listens on at the API. Both sides import these, so the policy the page needs
// and the policy the server allows cannot drift apart.

/** The pages of LB-06's board, in English and in Czech. */
export const LB06_BOARD_PAGE_ROUTES = ['/systems/lb-06/board', '/cs/systems/lb-06/board'] as const

/** Where LB-06's feed listens on the API's host (services/node-systems/README.md, "The LB-06 WebSocket"). */
export const LB06_SOCKET_PATH = '/ws/lb06/'
