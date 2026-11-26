import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

import { runNodeTests } from '@lostgradient/testing/node-runtime';
import { expect, test } from 'bun:test';

const fixtureDirectory = mkdtempSync(
  join(
    '/Users/stevekinney/Documents/ChatGPT/corvidae/tmp/chef/2026-11-25-185127-corvidae-workers-and-npm-COR-2746-brief/scratch/COR-2746-37ec0938',
    'node-realm-fixtures-',
  ),
);
const fixtureBuild = await Bun.build({
  entrypoints: [
    join(import.meta.dir, '__fixtures__/sentinel-worker.fixture.ts'),
    join(import.meta.dir, '__fixtures__/sentinel-child-process.fixture.ts'),
  ],
  format: 'esm',
  outdir: fixtureDirectory,
  target: 'node',
  naming: '[name].mjs',
});
if (!fixtureBuild.success) throw new Error(fixtureBuild.logs.map((log) => log.message).join('\n'));
const [workerFixture, childFixture] = fixtureBuild.outputs.map((output) => output.path);
if (workerFixture === undefined || childFixture === undefined)
  throw new Error('Node realm fixtures missing');

const result = await runNodeTests([join(import.meta.dir, 'node-runtime.test-support.ts')], {
  bundle: true,
  env: {
    WEFT_NODE_CHILD_REALM_FIXTURE: childFixture,
    WEFT_NODE_WORKER_REALM_FIXTURE: workerFixture,
  },
});

test('Weft realm transports run under pinned Node 22+', () => {
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.failCount).toBe(0);
  expect(result.passCount).toBe(2);
});
