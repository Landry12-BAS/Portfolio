// What the site takes of a file for LB-03 (the Invoice Reader), which the site's server enforces and
// the board checks before it sends anything, so the two cannot differ. The service itself takes
// files of 10 MB (services/flask-systems/lb03/limits.py), and a caller of the API directly may use all
// of it. The hosted site takes less, because it is a Vercel function: a function's request body may
// not be larger than 4.5 MB, and a multipart form wraps its file in a few hundred bytes. A file of 4 MiB
// and a form around it stay under that, with room.

// The most bytes of a file the site takes: 4 MiB.
export const LB03_SITE_FILE_BYTES = 4 * 1_024 * 1_024
// What a multipart form adds to its file (boundaries and headers), with room: 16 KiB.
export const LB03_FORM_ENVELOPE_BYTES = 16 * 1_024
// The most bytes of the whole upload the site's server reads and passes on.
export const LB03_SITE_UPLOAD_BYTES = LB03_SITE_FILE_BYTES + LB03_FORM_ENVELOPE_BYTES
