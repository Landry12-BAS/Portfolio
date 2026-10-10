// A worker that asks for more memory than it may have: it holds on to everything it allocates. The test of
// the memory limit gives the extraction this script and checks that the thread is ended by its limit, the
// file is refused, and the process that started it goes on.
const held: number[][] = []
for (;;) held.push(Array.from({ length: 1_000_000 }, () => Math.random()))
export { held }
