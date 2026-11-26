import { runNodeTests } from '@lostgradient/testing/node-runtime';
import { expect, test } from 'bun:test';

const result = await runNodeTests([
  new URL('./node-runtime.test-support.ts', import.meta.url).pathname,
]);

test('runs the cryptography vectors under native Node', () => {
  expect(result.exitCode).toBe(0);
  expect(result.failCount).toBe(0);
  expect(result.passCount).toBe(2);
});
