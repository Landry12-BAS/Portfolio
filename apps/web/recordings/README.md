# Recordings of the curated samples

A demo replays a recording of a real run instead of spending quota, and labels it as a replay
(docs/PLAYBOOK.md, principle 5 and step 9). A recording is one file per sample,
`<system>/<sample>.json`, such as `lb-01/torn-bag.json`, in the format `recordingSchema` defines
in `packages/contracts/src/replay/recording.ts`: the requests the board made, the answers it
got, and the spans of the run.

The ones here were made on 2026-10-07 on a development machine (x86-64), against the whole
platform running locally (the gateway, the three back ends, Postgres, Redis and LB-07's sandbox)
with the real providers behind the gateway: Groq and Workers AI, and OpenRouter for synthetic
content only. Each is one real run with real model calls, and its timings are that machine's and
those providers' on that day; a run's trace says which model answered each call, since a busy
minute sends a call down its route's fallbacks. 65 of the 66 curated samples have one. None is
invented: until a sample has one, its board says so and offers the live run, which spends the
visitor's quota. This one has none yet:

| Sample | Why not yet |
|---|---|
| `lb-07/partner-link` | The planner declines to click the About page's partner links, as its prompt tells it (they lead outside the shop), so the sandbox's stop that the sample is there to show never happens, and the verdict is passing where the golden set expects not_verified. Recording it waits on a choice: let the planner click a link the goal names and leave the stop to the sandbox (a prompt change, with LB-07's live eval), or make the sample show the refusal. |

To make one:

```sh
# The back end, the gateway and the keys the site's server uses (docs/DEPLOY.md, parts 6 and 10).
LB_API_URL=https://api.example.com LB_GATEWAY_URL=https://api.example.com \
LB_WEB_SIGNING_KEY_FILE=~/lb-keys/site.jwk.json LB_GATEWAY_SERVICE_KEY_FILE=~/lb-keys/web.jwk.json \
just record-sample lb-01 torn-bag
```

The command runs the sample, waits for the pipeline, reads the run's spans from the gateway,
checks the result against the schema and writes the file here. Commit it with the change that
shipped the system, and replace it whenever the prompts or the routing change enough to change the
run. Only a recording whose `origin` is `live` is ever shown to a visitor; the test mock's
recordings (`origin: mock`) live in `e2e/fixtures/recordings` and are bundled into the test
build alone.
