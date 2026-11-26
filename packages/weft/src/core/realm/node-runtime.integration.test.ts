import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runNodeTests } from '@lostgradient/testing/node-runtime';
import { expect, test } from 'bun:test';

const fixtureDirectory = mkdtempSync(join(tmpdir(), 'weft-node-realm-fixtures-'));
const result = await (async () => {
  try {
    const fixtureBuild = await Bun.build({
      entrypoints: [
        join(import.meta.dir, '__fixtures__/node-runtime-activity-worker.fixture.ts'),
        join(import.meta.dir, '__fixtures__/node-runtime-activity-child.fixture.ts'),
      ],
      format: 'esm',
      outdir: fixtureDirectory,
      target: 'node',
      naming: '[name].mjs',
    });
    if (!fixtureBuild.success)
      throw new Error(fixtureBuild.logs.map((log) => log.message).join('\n'));
    const [workerFixture, childFixture] = fixtureBuild.outputs.map((output) => output.path);
    if (workerFixture === undefined || childFixture === undefined)
      throw new Error('Node realm fixtures missing');

    return await runNodeTests([join(import.meta.dir, 'node-runtime.test-support.ts')], {
      bundle: true,
      env: {
        WEFT_NODE_CHILD_REALM_FIXTURE: childFixture,
        WEFT_NODE_WORKER_REALM_FIXTURE: workerFixture,
      },
    });
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
})();

test('Weft realm transports run under pinned Node 22+', () => {
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.failCount).toBe(0);
  expect(result.passCount).toBe(8);
});
