# Recordings of the curated samples

A demo replays a recording of a real run instead of spending quota, and labels it as a replay
(docs/PLAYBOOK.md, principle 5 and step 9). A recording is one file per sample,
`<system>/<sample>.json`, such as `lb-01/torn-bag.json`, in the format `recordingSchema` defines
in `packages/contracts/src/replay/recording.ts`: the requests the board made, the answers it
got, and the spans of the run.

**There are none here yet.** A recording is made against a live back end with a real model
behind it, and none was available when the site was built, so no recording has been made, and
none is invented: until a sample has one, its board says so and offers the live run, which
spends the visitor's quota. To make one:

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
