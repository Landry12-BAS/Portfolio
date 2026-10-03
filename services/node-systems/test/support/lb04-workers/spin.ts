// A worker that never answers: it computes for ever. The test of the time limit gives the extraction this
// script and checks that the file is refused as a timeout and the thread is ended.
const started = Date.now()
while (Date.now() >= started) {
  // Nothing: the loop ends only if the clock runs backwards.
}
