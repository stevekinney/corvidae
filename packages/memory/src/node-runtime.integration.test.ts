import { runNodeTests } from '@lostgradient/testing/node-runtime';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
const result = await runNodeTests([join(import.meta.dir, 'node-runtime.test-support.ts')], {
  bundle: true,
});
test('memory runs on Node 22', () => {
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.passCount).toBeGreaterThan(0);
});
