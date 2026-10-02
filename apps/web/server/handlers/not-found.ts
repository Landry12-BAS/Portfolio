// Everything under /api/ that no other handler answers: a 404 in the platform's error shape, so
// an unknown path never falls through to the site's HTML 404 page, which a script would have to
// guess is an error.
import { defineApiHandler } from '../lib/api.ts'
import { problems } from '../lib/errors.ts'

/** Answers every unknown API path with the platform's 404. */
export default defineApiHandler(() => {
  throw problems.notFound()
})
