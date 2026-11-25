/**
 * The subset of Bungalow's behavior that must hold on Node 22 or later, as `node --test` cases.
 * `node-runtime.integration.test.ts` runs this file in a native Node child, against an S3 test
 * server it starts and names in `BUNGALOW_NODE_S3_ENDPOINT` and `BUNGALOW_NODE_S3_BUCKET`.
 *
 * It imports only the package source and Node built-ins: no `bun:` module, no `Bun` global, and no
 * `@lostgradient/testing` helper, so a pass here means the package itself runs on Node. It covers
 * a local open on the portable lock, the lock refusing a second holder in this process and in
 * another Node process the parent started (`BUNGALOW_NODE_HELD_ROOT`, `BUNGALOW_NODE_HOLDER_PID`),
 * the default lock's refusal on Node, local secrets and configuration, a remote open's
 * conditional writes and listing, and the runner-neutral conformance suites under `node:test`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { openBungalow, openLocalBungalow, type Bungalow } from './bungalow.ts';
import { describeBungalow, describeDeploymentSecrets, describeRootLock } from './conformance.ts';
import { BungalowLockedError, BungalowUnsupportedError } from './errors.ts';
import { acquirePortableLock } from './lock.ts';

const NAME = 'bungalow-node';
const runner = { describe, test };
const roots: string[] = [];
after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bungalow-node-'));
  roots.push(root);
  return root;
}

function openLocal(root: string): Promise<Bungalow> {
  return openLocalBungalow({ name: NAME, root, acquireLock: acquirePortableLock });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a rejection.');
}

describe('on Node', () => {
  test('runs on Node 22 or later, not Bun', () => {
    assert.equal(typeof (globalThis as { Bun?: unknown }).Bun, 'undefined');
    assert.ok(Number(process.versions.node.split('.')[0]) >= 22);
  });

  test('the default lock refuses, naming the portable lock', async () => {
    const error = await rejection(openLocalBungalow({ name: NAME, root: temporaryRoot() }));
    assert.ok(error instanceof BungalowUnsupportedError);
    assert.match(error.message, /acquirePortableLock/);
  });
});

describe('a local home on the portable lock', () => {
  test('opens, keeps its identity, and stores secrets and configuration', async () => {
    const root = temporaryRoot();
    const first = await openLocal(root);
    assert.equal(first.mode, 'local');
    assert.equal(first.objectStore(), undefined);
    await first.deploymentSecrets.write('api-key', 'sk-node');
    const created = await first.writeConfiguration('{"a":1}\n', { expectedRevision: null });
    assert.equal(created.outcome, 'committed');
    const deploymentId = first.deploymentId;
    first.close();

    const second = await openLocal(root);
    try {
      assert.equal(second.deploymentId, deploymentId);
      assert.equal(await second.deploymentSecrets.read('api-key'), 'sk-node');
      const snapshot = await second.readConfiguration();
      assert.equal(snapshot.text, '{"a":1}\n');
      const stale = await second.writeConfiguration('{}\n', { expectedRevision: null });
      assert.equal(stale.outcome, 'conflict');
    } finally {
      second.close();
    }
  });

  test('refuses a second holder in this process, and admits one after close', async () => {
    const root = temporaryRoot();
    const first = await openLocal(root);
    const refused = await rejection(openLocal(root));
    assert.ok(refused instanceof BungalowLockedError);
    assert.equal(refused.holderProcessIdentifier, process.pid);
    first.close();
    const next = await openLocal(root);
    next.close();
  });

  test('refuses while another Node process holds it, naming that process', async () => {
    // The parent started the holder (test processes start through its hang guard) and names it
    // here; after this suite it kills the holder and checks that the root is free again.
    const root = process.env['BUNGALOW_NODE_HELD_ROOT'];
    const holder = Number(process.env['BUNGALOW_NODE_HOLDER_PID']);
    assert.ok(root !== undefined && Number.isSafeInteger(holder) && holder > 0);
    const refused = await rejection(openLocal(root));
    assert.ok(refused instanceof BungalowLockedError);
    assert.equal(refused.holderProcessIdentifier, holder);
  });
});

describeRootLock(runner, acquirePortableLock);

/** One root every open of the home conformance suite reopens. */
let shared: string | undefined;
function sharedRoot(): string {
  shared ??= temporaryRoot();
  return shared;
}

describeBungalow(runner, (options) =>
  openLocalBungalow({
    name: NAME,
    root: sharedRoot(),
    acquireLock: acquirePortableLock,
    ...options,
  }),
);

describeDeploymentSecrets(runner, async () => {
  const home = await openLocal(temporaryRoot());
  after(() => home.close());
  return home.deploymentSecrets;
});

const endpoint = process.env['BUNGALOW_NODE_S3_ENDPOINT'];
const bucket = process.env['BUNGALOW_NODE_S3_BUCKET'];

describe('a remote home', () => {
  test('is configured by the parent', () => {
    assert.ok(endpoint !== undefined && bucket !== undefined);
  });

  if (endpoint === undefined || bucket === undefined) return;

  const environment = {
    BUNGALOW_NODE_DATABASE_URL: 'postgres://bungalow@127.0.0.1:5432/bungalow',
    BUNGALOW_NODE_BUCKET: bucket,
    BUNGALOW_NODE_BUCKET_PREFIX: 'node-tenant',
    BUNGALOW_NODE_SECRET_API_KEY: 'sk-remote',
    S3_ENDPOINT: endpoint,
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY_ID: 'node-access-key',
    S3_SECRET_ACCESS_KEY: 'node-secret-key',
  };
  const open = () =>
    openBungalow({
      name: NAME,
      environment,
      databaseWorkspaceClaim: async () => {},
      writableConfiguration: true,
    });

  test('opens, keeps its identity, and makes its writes conditional', async () => {
    const first = await open();
    try {
      assert.equal(first.mode, 'remote');
      assert.equal(await first.deploymentSecrets.read('api-key'), 'sk-remote');
      const created = await first.writeConfiguration('{"v":1}\n', { expectedRevision: null });
      assert.deepEqual(created, { outcome: 'committed' });
      const again = await first.writeConfiguration('{"v":2}\n', { expectedRevision: null });
      assert.deepEqual(again, { outcome: 'conflict' });
      const current = await first.readConfiguration();
      assert.equal(current.text, '{"v":1}\n');
      assert.ok(current.revision !== null);
      const replaced = await first.writeConfiguration('{"v":3}\n', {
        expectedRevision: current.revision,
      });
      assert.deepEqual(replaced, { outcome: 'committed' });
      const stale = await first.writeConfiguration('{"v":4}\n', {
        expectedRevision: current.revision,
      });
      assert.deepEqual(stale, { outcome: 'conflict' });
      const final = await first.readConfiguration();
      assert.equal(final.text, '{"v":3}\n');
    } finally {
      first.close();
    }
    const second = await open();
    try {
      assert.equal(second.deploymentId, first.deploymentId);
      assert.equal(second.workspaceId, first.workspaceId);
    } finally {
      second.close();
    }
  });

  test('lists and presigns through its object store', async () => {
    const home = await open();
    try {
      const store = home.objectStore();
      assert.ok(store !== undefined);
      const put = await fetch(store.presign('node-tenant/agents/a.md', { method: 'PUT' }), {
        method: 'PUT',
        headers: { 'if-none-match': '*' },
        body: 'agent',
      });
      assert.equal(put.status, 200);
      const listing = await store.list({ prefix: 'node-tenant/agents/' });
      assert.deepEqual(
        listing.contents?.map((entry) => entry.key),
        ['node-tenant/agents/a.md'],
      );
      const read = await fetch(store.presign('node-tenant/agents/a.md'));
      assert.equal(await read.text(), 'agent');
    } finally {
      home.close();
    }
  });
});
