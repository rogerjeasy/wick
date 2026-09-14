/**
 * Local store of REAL playback events.
 *
 * §12.1 and check:no-mocks — runtime code uses real data. The Vega sample ships
 * ContentPersonalizationMocks wired into this path; it is deliberately absent
 * here and the CI guard keeps it that way.
 */
// TODO(S6): persist via kepler-file-system; chunked reads for the refresh handler.
export {};
