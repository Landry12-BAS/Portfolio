"""LB-09's operating limits in one place: the datasheet's numbers, and the ones that keep them true.

The datasheet promises recordings of up to 60 seconds, 5 recordings a visitor a day, audio kept only
until it is transcribed, and 2 to 3 model calls a meeting beside the transcription. The rest of the
numbers keep those promises, or keep a hostile visitor from costing more than a friendly one. The
pipeline, the API, the WebSocket and the tests all read them from here, and a test checks that the
gateway's quotas for LB-09 in routing.yaml leave room for them.
"""

from datetime import timedelta
from typing import Final

from core.structured import ReasoningEffort

# The datasheet's limits.
MAX_RECORDING_SECONDS: Final = 60.0
RECORDINGS_PER_VISITOR_PER_DAY: Final = 5
# A recording shorter than this has no speech to find.
MIN_RECORDING_SECONDS: Final = 0.5

# How long a visitor's transcript, labels and items are kept, and so how long the page can reopen them.
VISITOR_DATA_LIFETIME: Final = timedelta(hours=24)
# Audio is deleted the moment it has been transcribed, on success and on failure. A crash can leave a file
# behind, so the sweeper removes any audio file older than this.
AUDIO_MAX_AGE: Final = timedelta(hours=1)
# A meeting that has not finished this long after it was made is marked failed, and its audio removed:
# the worker is down, or lost the job.
STALE_MEETING_AFTER: Final = timedelta(minutes=10)

# What the API accepts. The recording arrives in a JSON body as base64, since the site relays JSON only and
# a serverless function takes about 4.5 MB: 3 MiB of audio is 4 MiB of base64, inside both. A minute of
# browser audio is about 1 MB, and a minute of 16 kHz WAV is 1.9 MB.
MAX_UPLOAD_BYTES: Final = 3 * 1024 * 1024
# The JSON field may hold a little more than the cap, so an upload just over it is told it is too big, not malformed.
MAX_UPLOAD_BASE64_CHARS: Final = (MAX_UPLOAD_BYTES * 4 + 2) // 3 + 4_096

# Decoding a recording runs in a child process the operating system holds to these bounds, so that a file
# built to blow up (a few kilobytes that decode to hours of silence) costs a bounded amount of time and memory.
DECODE_WALL_SECONDS: Final = 15.0
DECODE_CPU_SECONDS: Final = 10
DECODE_MEMORY_BYTES: Final = 1024 * 1024 * 1024
# The child stops as soon as it has produced more audio than a recording may hold, plus this much, which
# lets a recording that is a hair over still be measured and refused for its length.
DECODE_SLACK_SECONDS: Final = 2.0

# What a transcript may hold before the model sees it. A minute of speech is about 150 words.
MAX_SEGMENTS: Final = 120
MAX_TRANSCRIPT_CHARS: Final = 6_000
# Whisper makes up text over silence. A segment it is this unsure of is dropped.
NO_SPEECH_PROBABILITY: Final = 0.6
LOW_CONFIDENCE_LOGPROB: Final = -1.0
# The same segment this many times in a row is a loop, and the extra copies are dropped.
MAX_REPEATED_SEGMENTS: Final = 2

# The speakers a label may name, and the items a meeting may hold.
MAX_SPEAKERS: Final = 6
MAX_DECISIONS: Final = 10
MAX_ACTIONS: Final = 15
# An evidence quote has to be long enough to say something and to be found only where it was said.
MIN_EVIDENCE_WORDS: Final = 3

# Gateway calls a meeting makes: the transcription (fast mode only), speaker labels and the extraction, and
# one repair of each answer that does not validate. Normally 2 chat calls; the datasheet's 2 to 3 allows a
# repair; the worst is 4 chat calls and the transcription. The gateway's cap for LB-09 in routing.yaml sits
# one call above, so a meeting is stopped by this code, never refused halfway by the gateway.
CHAT_CALLS_AT_MOST: Final = 4
MODEL_CALLS_AT_MOST: Final = CHAT_CALLS_AT_MOST + 1
# Output caps, which the gateway counts against its token budgets; a reasoning model's thinking counts against
# them too. The labeller is asked to think briefly: at its default effort gpt-oss-20b spent 929 to 1,022 of
# lb-fast's 1,024 tokens thinking about the sample meetings and cut their labels off, and at low effort the
# labels took 237 to 612. The extractor thinks at its default effort: at low effort it copied the speaker
# labels into its quotes and lost every item of the Monday meeting to the evidence check, and at its default
# effort it found every item of the three, in 507 to 955 tokens. Both caps are their aliases' own (measured
# through the gateway on the samples' real transcripts, 2026-10-07).
LABEL_MAX_TOKENS: Final = 1_024
LABEL_REASONING_EFFORT: Final[ReasoningEffort] = "low"
EXTRACT_MAX_TOKENS: Final = 2_048

# Celery: how long a meeting's task may run before it is stopped (a private transcription is the slow part),
# and how long a queued task may wait before it is dropped instead of run late.
TASK_SOFT_TIME_LIMIT_SECONDS: Final = 150
TASK_TIME_LIMIT_SECONDS: Final = 180
TASK_EXPIRES_SECONDS: Final = 300

# The WebSocket: how long a new connection has to present its token, how long an open one may stay silent,
# and the largest frame it may send, in bytes. A connection only says hello, so the frame is small.
HELLO_TIMEOUT_SECONDS: Final = 10.0
IDLE_TIMEOUT_SECONDS: Final = 300.0
MAX_FRAME_BYTES: Final = 2_048
# Connections one visitor may have open at once in one server process.
MAX_CONNECTIONS_PER_VISITOR: Final = 4
# Frames one connection may send after its hello before it is closed: a page sends nothing more.
MAX_FRAMES_PER_CONNECTION: Final = 8
# How long a connection stays open after its meeting has ended, so the page can read the last event.
LINGER_AFTER_END_SECONDS: Final = 5.0
