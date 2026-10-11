// useRevealOnScroll: the parts of a page below the fold come in as the visitor scrolls to them, with a
// short rise and fade (the lb-reveal classes in packages/ui, base.css). Nothing is ever hidden from
// someone who can see it: the page renders whole on the server, and only once it is on screen and
// scripted are the parts still below the fold set back, so there is no flash and no empty page without
// JavaScript. Parts that arrive together are staggered by their place among their siblings. A visitor
// who asked for less motion is left alone: everything stays in place.

/** How far apart siblings that come in together are, and the most of them that are staggered. */
const STAGGER_MS = 50
const STAGGER_CAP = 9

/** Sets the parts matched by the selectors to come in as they are scrolled to, from the next frame on. */
export function useRevealOnScroll(selectors: readonly string[]): void {
  onMounted(() => {
    if (typeof IntersectionObserver === 'undefined') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const parts = [...document.querySelectorAll<HTMLElement>(selectors.join(', '))]
      .filter(part => part.getBoundingClientRect().top > window.innerHeight)
    if (parts.length === 0) return

    const placeAmongSiblings = new Map<HTMLElement, number>()
    const countByParent = new Map<HTMLElement | null, number>()
    for (const part of parts) {
      const parent = part.parentElement
      const place = countByParent.get(parent) ?? 0
      placeAmongSiblings.set(part, place)
      countByParent.set(parent, place + 1)
      part.style.setProperty('--lb-reveal-delay', `${Math.min(place, STAGGER_CAP) * STAGGER_MS}ms`)
      part.classList.add('lb-reveal')
    }

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('lb-reveal-in')
        observer.unobserve(entry.target)
      }
    }, { rootMargin: '0px 0px -8% 0px' })
    for (const part of parts) observer.observe(part)

    onBeforeUnmount(() => observer.disconnect())
  })
}
