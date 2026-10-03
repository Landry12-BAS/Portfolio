"""LB-10's operating limits: the datasheet's promises, as the constants the code enforces them with.

The datasheet (apps/web/shared/data/systems.ts) promises ten cases a visitor run, one run a visitor a day,
results cached by prompt hash and about twenty model calls a run. The gateway's routing.yaml holds the
second line behind each of these (lb-10: maxCallsPerRun 40, sessionDailyCalls 40).
"""

# What a visitor may edit: the system prompt, as plain text of at most this many characters.
MAX_PROMPT_CHARS = 4_000
# How many cases a visitor run uses, and how many providers it may run them on.
CASES_PER_RUN = 10
MAX_PROVIDERS_PER_RUN = 2
# One run a visitor a day, and how many of them the service gives back when it is the one that failed.
RUNS_PER_DAY = 1
MAX_REFUNDS_PER_DAY = 2
# The most model calls one run may make: the edited prompt and the production prompt on every case, on every
# provider (production's are cached after the first visitor, so about twenty calls is the usual run).
MAX_CALLS_PER_RUN = CASES_PER_RUN * MAX_PROVIDERS_PER_RUN * 2
# How many model calls are in flight at once: enough to overlap the waits, few enough for Groq's requests a minute.
CONCURRENCY = 4
# How long one model call may take, and how long a whole run has before it is ended as timed out.
CALL_TIMEOUT_SECONDS = 60.0
RUN_DEADLINE_SECONDS = 300.0
# How many bootstrap resamples the confidence intervals use, and their level.
BOOTSTRAP_RESAMPLES = 1_000
CONFIDENCE_LEVEL = 0.95
# A visitor has one run going at a time; the flag outlives the run's deadline a little, so a slow run isn't cut off.
BUSY_SECONDS = int(RUN_DEADLINE_SECONDS) + 30
# Counters older than this many days are deleted: a visitor's day is over, and no history is kept.
KEEP_DAYS = 2
# A finished run is kept this many days, so a visitor can come back to it; then it is deleted.
RUN_KEEP_DAYS = 7
