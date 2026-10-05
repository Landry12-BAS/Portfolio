// What the page and the server must agree on about LB-09's board: the two pages (one for each
// language) whose Content Security Policy and Permissions-Policy differ from every other page's,
// because the board records with the microphone and follows a meeting over the API's WebSocket.
// Both sides import these, so the page the browser asks for and the pages the server widens cannot
// drift apart.

/** The pages of LB-09's board, in English and in Czech. */
export const LB09_BOARD_PAGE_ROUTES = ['/systems/lb-09/board', '/cs/systems/lb-09/board'] as const

/** Where LB-09's meeting progress listens on the API's host (services/django-systems/config/routing.py). */
export const LB09_SOCKET_PATH = '/ws/lb09/'
