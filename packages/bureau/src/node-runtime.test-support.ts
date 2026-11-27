/** The native Node portion of COR-2747's Bureau smoke. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  createS3ObjectOperations,
  createSigV4Presigner,
  type SigV4PresignerOptions,
} from '@lostgradient/object-store';
import { createAgent } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';

import { createBureau } from '@lostgradient/bureau';
import * as skills from '@lostgradient/bureau/skills';
import { agentFileDirectory, agentObjectSource } from '@lostgradient/bureau/sources';
import * as toolOperations from '@lostgradient/bureau/tool-operations';
import * as workflowJson from '@lostgradient/bureau/workflow-json';

import { readEnvironmentVariable } from './skills/environment-configuration.ts';

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function s3Options(): SigV4PresignerOptions {
  const text = readEnvironmentVariable('BUREAU_NODE_S3_OPTIONS');
  assert.ok(text !== undefined, 'the Bun parent supplies S3 server options');
  return JSON.parse(text) as SigV4PresignerOptions;
}

test('loads the root and each non-testing public subpath', () => {
  assert.equal(typeof createBureau, 'function');
  assert.ok(Object.keys(skills).length > 0);
  assert.ok(Object.keys(toolOperations).length > 0);
  assert.ok(Object.keys(workflowJson).length > 0);
});

test('creates a Bureau and completes an inline-agent run', async () => {
  const bureau = await createBureau({
    agents: {
      node: createAgent({
        name: 'node',
        generate: async () => ({ content: 'Node 22', toolCalls: [] }),
      }),
    },
    storage: new MemoryStorage(),
  });
  try {
    const task = await bureau.tasks.start('node', 'smoke');
    const result = await task.result();
    assert.equal(result.content, 'Node 22');
  } finally {
    await bureau.dispose();
  }
});

test('loads agent definitions from a local directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-node-'));
  roots.push(directory);
  await writeFile(join(directory, 'from-directory.md'), 'Directory definition\n');
  const definitions = await agentFileDirectory(directory, { watch: false }).load();
  assert.deepEqual(
    definitions.map(({ id }) => id),
    ['from-directory'],
  );
});

test('loads agent definitions from S3 object-store operations', async () => {
  const options = s3Options();
  const source = agentObjectSource(
    { bucket: options.bucket, prefix: 'agents' },
    {
      watch: false,
      operations: createS3ObjectOperations({
        bucket: options.bucket,
        contentType: 'text/markdown; charset=utf-8',
        presigner: createSigV4Presigner(options),
      }),
    },
  );
  const definitions = await source.load();
  assert.deepEqual(
    definitions.map(({ id }) => id),
    ['from-s3'],
  );
});
