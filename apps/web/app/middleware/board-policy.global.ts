// Board CSP and permissions come from response headers, which client-side routing cannot replace.
// Load a fresh document when entering, leaving or changing boards; keep same-page updates local.

/** Applies the destination's document policy without widening any page's security headers. */
export default defineNuxtRouteMiddleware((to, from) => {
  if (import.meta.server || to.path === from.path) return
  const board = /^\/(?:cs\/)?systems\/[^/]+\/board\/?$/
  if (board.test(to.path) || board.test(from.path)) {
    return navigateTo(to.fullPath, { external: true })
  }
})
