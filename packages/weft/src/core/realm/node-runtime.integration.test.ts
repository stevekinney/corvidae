import { join } from 'node:path';

import { runNodeTests } from '@lostgradient/testing/node-runtime';
import { expect, test } from 'bun:test';

const result = await runNodeTests([join(import.meta.dir, 'node-runtime.test-support.ts')], {
  bundle: true,
});

test('Weft realm transports run under pinned Node 22+', () => {
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.failCount).toBe(0);
  expect(result.passCount).toBe(1);
});
