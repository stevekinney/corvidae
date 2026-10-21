/**
 * The ids of the run-detail fixture runs (`fixtures/engine-console.ts`), in a module of their own
 * with no imports so a Playwright spec can name the runs it opens without loading the engine.
 */
export const ATTRIBUTE_SHOWCASE_RUN_ID = 'e2e-attribute-showcase';
export const CHUNK_STREAMER_RUN_ID = 'e2e-chunk-streamer';
export const UPDATE_DESK_RUN_ID = 'e2e-update-desk';
/** A second `update-desk` run with no updates, for the spec that sends one over REST from a browser. */
export const UPDATE_DESK_REPLAY_RUN_ID = 'e2e-update-desk-replay';
