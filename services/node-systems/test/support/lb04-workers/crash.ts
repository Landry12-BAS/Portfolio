// A worker that fails with an error nobody planned for.
throw new Error('this worker was told to crash, and says so in words that must never reach a visitor')
