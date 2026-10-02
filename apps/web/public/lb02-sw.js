// The service worker of LB-02's installable board. It does one small job: it keeps the board's own
// page and the static files that page loads (scripts, styles, fonts, the app's icon and manifests) on
// the visitor's device, so the app opens without a connection. It keeps nothing else, by design:
//
//   - only GET requests to this site's own origin are looked at; everything else (the API, the
//     WebSocket's host, Turnstile, any other site) goes to the network as if the worker did not exist,
//     and a WebSocket never passes through a service worker at all;
//   - only the two pages of the board (one for each language, with no query) and the files in the
//     folders the build names by their content are ever stored, and only when the answer is a plain 200;
//   - the API (/api/...), tokens, conversations, the calendar and recordings are never stored: they
//     are not in the lists below, and /api/ is also refused by name;
//   - the page is fetched from the network first and the stored copy is used only when the network
//     fails, so a visitor online always gets the current page; static files are named by their
//     content, so a stored copy is always the right one.
//
// A page is controlled by the worker from the next load after it is installed (the worker does not
// take over a page that is already open), so what a controlled page loaded is exactly what was kept.
// The worker is a plain script and is not built, because a service worker must be served as it is.
'use strict'

// The names of the two caches. The version in the name is changed when this file's rules change, and
// the worker then removes every older cache of the board.
const SHELL_CACHE = 'lb02-shell-v1'
const OFFLINE_CACHE = 'lb02-offline-v1'
const CACHE_PREFIX = 'lb02-'

// The most files the shell cache keeps. The oldest go first, so the cache cannot grow without bound
// as the site is updated and its files get new names.
const MAX_SHELL_ENTRIES = 80

// The board's pages, one for each language: the only pages the worker keeps.
const BOARD_PAGES = ['/systems/lb-02/board', '/cs/systems/lb-02/board']

// The folders of static files the build names by their content, and the one folder inside them that is not so
// named: the build's own record of itself (/_nuxt/builds/latest.json) changes with every deploy under a fixed name.
const STATIC_FOLDERS = ['/_nuxt/']
const UNNAMED_BY_CONTENT = ['/_nuxt/builds/']

// The files of the app itself.
const APP_FILES = ['/lb02-icon.svg', '/lb02.en.webmanifest', '/lb02.cs.webmanifest']

// The page shown when there is no connection and the board's own page is not on the device, for each language.
const OFFLINE_PAGES = { en: '/lb02-offline.en.html', cs: '/lb02-offline.cs.html' }

/** Tells which language this worker serves, from the part of the site it was registered for. */
function languageOfScope() {
  return new URL(self.registration.scope).pathname.startsWith('/cs/') ? 'cs' : 'en'
}

/** Tells whether an address is one of the board's pages, with no query. */
function isBoardPage(url) {
  return url.search === '' && BOARD_PAGES.includes(url.pathname)
}

/** Tells whether an address is a static file the worker keeps. The API is refused by name, whatever else is listed. */
function isStaticFile(url) {
  if (url.pathname.startsWith('/api/')) return false
  if (UNNAMED_BY_CONTENT.some(folder => url.pathname.startsWith(folder))) return false
  if (APP_FILES.includes(url.pathname)) return true
  return STATIC_FOLDERS.some(folder => url.pathname.startsWith(folder))
}

/** Tells whether an answer may be kept: a complete answer from this site's own server that does not ask not to be stored. */
function mayKeep(response) {
  if (response.status !== 200 || response.type !== 'basic') return false
  const control = response.headers.get('cache-control') ?? ''
  return !/no-store/i.test(control)
}

/** Removes the oldest files from the shell cache until it is within its limit. */
async function trim(cache) {
  const keys = await cache.keys()
  const excess = keys.length - MAX_SHELL_ENTRIES
  for (const key of keys.slice(0, Math.max(excess, 0))) await cache.delete(key)
}

/** Keeps a copy of an answer in the shell cache. */
async function keep(request, response) {
  const cache = await caches.open(SHELL_CACHE)
  await cache.put(request, response)
  await trim(cache)
}

/** Answers a request for the board's page: from the network when it can, from the device when it cannot. */
async function boardPage(request) {
  try {
    const fresh = await fetch(request)
    if (mayKeep(fresh)) await keep(request, fresh.clone())
    return fresh
  }
  catch {
    const kept = await caches.match(request, { cacheName: SHELL_CACHE })
    return kept ?? offlinePage()
  }
}

/** Answers a request for a static file: from the device when it is there, else from the network, keeping the copy. */
async function staticFile(request) {
  const kept = await caches.match(request, { cacheName: SHELL_CACHE })
  if (kept) return kept
  const fresh = await fetch(request)
  if (mayKeep(fresh)) await keep(request, fresh.clone())
  return fresh
}

/** Answers with the page that says there is no connection, or fails like the network does when even that is missing. */
async function offlinePage() {
  const page = await caches.match(OFFLINE_PAGES[languageOfScope()], { cacheName: OFFLINE_CACHE })
  return page ?? Response.error()
}

/** Decides what to do with a request: answer it, or return nothing so the browser sends it to the network as usual. */
function answerFor(request) {
  if (request.method !== 'GET') return undefined
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return undefined
  if (request.mode === 'navigate') return isBoardPage(url) ? boardPage(request) : undefined
  return isStaticFile(url) ? staticFile(request) : undefined
}

/** Keeps the page for no connection, in the language of the part of the site this worker was registered for. */
async function keepOfflinePage() {
  const cache = await caches.open(OFFLINE_CACHE)
  await cache.add(OFFLINE_PAGES[languageOfScope()])
}

/** Removes every cache of the board that an older version of this worker made. */
async function forgetOldCaches() {
  const names = await caches.keys()
  const old = names.filter(name => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE && name !== OFFLINE_CACHE)
  await Promise.all(old.map(name => caches.delete(name)))
}

self.addEventListener('install', (event) => {
  event.waitUntil(keepOfflinePage().then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(forgetOldCaches())
})

self.addEventListener('fetch', (event) => {
  const answer = answerFor(event.request)
  if (answer) event.respondWith(answer)
})
