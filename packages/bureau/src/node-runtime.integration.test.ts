/**
 * COR-2747: run Bureau's Node-only smoke in a bundled native Node child. The S3 server stays in
 * Bun because it is a test double built on `Bun.serve`; the child receives only its connection
 * details and uses the portable object-store operations.
 */
import { join } from 'node:path';

import { runNodeTests } from '@lostgradient/testing/node-runtime';
import { createS3TestServer } from '@lostgradient/testing/s3-server';
import { expect, test } from 'bun:test';

await using server = createS3TestServer({ bucket: 'bureau-node' });
server.put('agents/from-s3.md', 'S3 definition\n');

const result = await runNodeTests([join(import.meta.dir, 'node-runtime.test-support.ts')], {
  bundle: true,
  env: {
    BUREAU_NODE_S3_OPTIONS: JSON.stringify(server.clientOptions()),
  },
});

test('Bureau runs on Node 22', () => {
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.passCount).toBe(4);
});
