// How a client tells the test mock from a real back end: the mock answers `{"mock": true}` at this
// address and no real back end serves it. The sample recorder (apps/web/scripts/record) asks, so a
// recording made on the mock is labelled as one and can never pass for a real run. It lives in a
// module of its own so the recorder can know the address without loading the whole mock.

/** The address the mock answers `{"mock": true}` on. */
export const MOCK_IDENTITY_PATH = '/__mock'
