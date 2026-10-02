"""The operating limits LB-03 enforces: the datasheet's promises, as the constants the code enforces them with.

The datasheet says 10 documents a visitor a day, 5 pages a file, files kept an hour and two to five
model calls a document. Each of those is a name here, and the API reports these same numbers
(`GET /api/lb03/quota`), so what a visitor is told and what the service does cannot differ.

One number differs on purpose: the service takes files of 10 MB, and the datasheet says 4 MB, because
the hosted site is a Vercel function whose request body may not be larger than 4.5 MB
(apps/web/shared/lb03-limits.ts). The service keeps the larger limit so it never depends on the site's.
"""

# Documents a visitor may upload in a day (UTC), counted atomically in Postgres (lb03/quota.py).
DOCUMENTS_PER_DAY = 10
# The most documents of one visitor that may be read at the same moment, so one visitor cannot hold the OCR worker.
MAX_ACTIVE_PER_VISITOR = 2
# Documents given back to a visitor when the service itself failed them, per day: a failure can be caused on
# purpose (a file that crashes the reader), so unlimited refunds would be unlimited free work.
MAX_REFUNDS_PER_DAY = 3

# The most bytes a file may have. Checked while the upload is read, before anything is stored or decoded.
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
# What a multipart body may weigh: the file and the few bytes of boundary and headers around it.
MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 64 * 1024
# The most pages a PDF may have. Counted by the OCR worker, because counting them means parsing the file.
MAX_PAGES = 5
# The most pixels one image, or one rendered page, may have: a decompression-bomb cap. 40 million is a
# 7,000 by 5,700 photograph, more than any phone makes and a few times what the reader needs.
MAX_IMAGE_PIXELS = 40_000_000
# The longest side of a page as the viewer and the OCR see it, in pixels. A page is rendered no larger.
PAGE_LONG_SIDE_PIXELS = 1_800
# The JPEG quality of the page pictures the viewer shows.
PAGE_JPEG_QUALITY = 85
# The longest side of the image sent to the vision model, in pixels, and the JPEG quality it is sent at.
MODEL_IMAGE_LONG_SIDE_PIXELS = 1_568
MODEL_IMAGE_QUALITY = 80

# How long a visitor's files, and what was read from them, are kept. The service deletes them itself at
# expiry (lb03/sweeper.py); R2's lifecycle rule only works in whole days, so it is a backstop, not the promise.
FILE_LIFETIME_SECONDS = 3_600

# Model calls one document may make, the injection check included, as the gateway counts them: the check
# (one call for each 2,800 characters of text, at most two), the extraction with one repair of a reply that is
# not the JSON asked for, and the one targeted repair of a failed check, which is never repaired itself. A
# short document that goes straight through costs two: one check and one extraction.
MAX_MODEL_CALLS = 5
# The time the model calls of one document have, after OCR, and the longest one model call may take.
DOCUMENT_DEADLINE_SECONDS = 150.0
MODEL_CALL_TIMEOUT_SECONDS = 50.0
# The most time a document's whole run may take, OCR and the rest included: the backstop behind every other
# limit, so a step nobody thought to bound still ends.
HARD_LIMIT_SECONDS = 240.0
# The least time worth starting a model call with.
MIN_CALL_SECONDS = 2.0
# How many documents one worker process reads at the same time. The rest wait their turn, in order.
MAX_DOCUMENTS_IN_FLIGHT = 8
# How often a worker says it is still reading the documents it holds, and how long an unfinished document may
# go without that sign of life before it counts as lost (its worker died): three missed signs.
HEARTBEAT_SECONDS = 30.0
STALE_AFTER_SECONDS = 90.0
# How often a worker looks for documents whose hour is over and for documents that were lost.
SWEEP_INTERVAL_SECONDS = 60.0
# How long a worker that is shutting down waits for the documents it holds before giving them up as interrupted.
SHUTDOWN_GRACE_SECONDS = 20.0

# The OCR worker's limits: wall-clock seconds, CPU seconds and address space in bytes, per document. Measured in the
# production image under the box's limits (1.5 CPUs, 2 GiB), a PDF of five pages, the most it reads, takes 22 s of wall
# time and 32 s of CPU time (the worker runs two threads) on a four-core x86 machine. The limits leave a little over
# twice that for a slower core and a busy box, and no more, since they are also what a hostile file may burn. With the
# model calls' 150 s they stay inside the 240 s of HARD_LIMIT_SECONDS.
OCR_WALL_SECONDS = 60.0
OCR_CPU_SECONDS = 80
OCR_MEMORY_BYTES = 3 * 1024 * 1024 * 1024
# How many OCR workers run at once. The box has two cores, so reading is one document at a time by default.
OCR_WORKERS = 1
