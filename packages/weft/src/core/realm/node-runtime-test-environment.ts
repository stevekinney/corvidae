/** Node-only realm-fixture paths, read once at the test process boundary. */
export function readNodeRuntimeRealmTestEnvironment(): {
  readonly childFixture: string | undefined;
  readonly workerFixture: string | undefined;
} {
  return {
    childFixture: process.env['WEFT_NODE_CHILD_REALM_FIXTURE'],
    workerFixture: process.env['WEFT_NODE_WORKER_REALM_FIXTURE'],
  };
}
