/**
 * COR-1764: one remote host on a live PostgreSQL and an S3-compatible bucket. A remote host locks
 * `durableOwnership` so no setting can turn off the leases that let hosts share runs, reports its
 * state as `s3://` locations and variable names, and reports its database with no credential.
 * Without a PostgreSQL the suite skips; the overlap itself is in `remote-overlap.slow.test.ts`.
 */
import { openPostgresTestDatabase } from '@lostgradient/testing/postgres-server';
import { createS3TestServer, type S3TestServer } from '@lostgradient/testing/s3-server';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import { startHost, type Host, type HostOptions } from './host.ts';
import { createFreshDatabaseUrl, remoteEnvironment } from './remote-backends.test-support.ts';

const database = await openPostgresTestDatabase();
const PASSWORD = 'database-password-that-must-not-leak';

const hosts: Host[] = [];

afterAll(async () => {
  await database?.[Symbol.asyncDispose]();
});

describe.skipIf(database === null)('a host on Postgres and S3', () => {
  let server: S3TestServer;

  beforeAll(() => {
    server = createS3TestServer();
  });

  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
  });

  afterAll(async () => {
    await server.stop();
  });

  async function start(options: Pick<HostOptions, 'settings'> = {}): Promise<Host> {
    const environment = remoteEnvironment(
      await createFreshDatabaseUrl(database, PASSWORD),
      server,
      `host/${crypto.randomUUID()}`,
    );
    const host = await startHost({ environment, port: 0, ...options });
    hosts.push(host);
    return host;
  }

  test('locks durableOwnership, and refuses to store it through the Bureau’s settings', async () => {
    const host = await start();

    const snapshot = await host.bureau.settings.get();
    expect(snapshot.keys['durableOwnership.ownership']).toMatchObject({
      locked: true,
      lockReason: 'shared-storage',
    });
    expect(snapshot.keys['tools.wakeup']?.locked).toBe(false);
    const refused = await host.bureau.settings.update(
      { 'durableOwnership.ownership': 'none' },
      { expectedRevision: snapshot.revision },
    );
    expect(refused).toMatchObject({ outcome: 'rejected', reason: 'locked' });
    const after = await host.bureau.settings.get();
    expect(after.values['durableOwnership.ownership']).not.toBe('none');
  });

  // COR-1978: a remote home keeps its secrets in the environment, so it refuses a hook that would
  // hold a signing secret here, and refuses an address on the deployment's own network. A hook that
  // holds no secret works.
  test('turns hooks on, without signing secrets or private-network addresses', async () => {
    const host = await start();
    const call = async (method: string, params: Record<string, unknown>) => {
      const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
      });
      return (await response.json()) as {
        result?: { id?: string };
        error?: { data?: { weftCode?: string; reason?: string } };
      };
    };
    expect(host.bureau.hooks).toBeDefined();

    const notify = await call('bureau.hooks.create', {
      events: ['review.requested'],
      action: { type: 'notify' },
    });
    expect(notify.error).toBeUndefined();

    const webhook = { events: ['review.requested'], signingSecret: 'a-secret-of-twenty-chars' };
    const locked = await call('bureau.hooks.create', {
      ...webhook,
      action: { type: 'webhook', url: 'https://receiver.example/hook' },
    });
    expect(locked.error?.data?.reason).toBe('deployment');

    const privateAddress = await call('bureau.hooks.create', {
      ...webhook,
      action: { type: 'webhook', url: 'http://10.0.0.8/hook' },
    });
    expect(privateAddress.error?.data?.weftCode).toBe('InvalidParams');
  });

  // COR-1797: the other restart-applied settings the overlap depends on.
  test.each([
    ['maintenance', 'manual'],
    ['durable', false],
    ['engine.workflowClaimTtl', 1_000],
    ['engine.workflowClaimRenewInterval', 500],
  ] as const)(
    'locks %s, and refuses to store %p through the Bureau’s settings',
    async (key, value) => {
      const host = await start();

      const snapshot = await host.bureau.settings.get();
      expect(snapshot.keys[key]).toMatchObject({ locked: true, lockReason: 'shared-storage' });
      const refused = await host.bureau.settings.update(
        { [key]: value },
        { expectedRevision: snapshot.revision },
      );
      expect(refused).toMatchObject({ outcome: 'rejected', reason: 'locked' });
      const after = await host.bureau.settings.get();
      expect(after.values[key]).not.toBe(value);
    },
  );

  test('keeps the locks its caller asked for beside its own', async () => {
    const host = await start({ settings: { locked: { workflowVersion: 'deployment' } } });

    const snapshot = await host.bureau.settings.get();
    expect(snapshot.keys['workflowVersion']).toMatchObject({
      locked: true,
      lockReason: 'deployment',
    });
    expect(snapshot.keys['durableOwnership.ownership']).toMatchObject({
      locked: true,
      lockReason: 'shared-storage',
    });
  });

  test('reports locations and variable names at /host/paths, and no credential anywhere', async () => {
    const host = await start();
    const client = server.clientOptions();

    const response = await fetch(new URL('/host/paths', host.url));
    const body = await response.text();
    const paths = JSON.parse(body) as Record<string, unknown>;
    const prefix = `s3://${client.bucket}/host/`;
    expect(paths['mode']).toBe('remote');
    expect(paths['database']).toEqual(host.database);
    expect(String(paths['agentDirectory'])).toStartWith(prefix);
    expect(String(paths['agentDirectory'])).toEndWith('/agents/');
    expect(String(paths['workflowDirectory'])).toEndWith('/workflows/');
    expect(String(paths['configurationFile'])).toStartWith(prefix);
    expect(String(paths['configurationFile'])).toEndWith('/configuration.json');
    expect(paths['providers']).toEqual([
      { name: 'anthropic', secretFile: 'INTERBOROUGH_SECRET_ANTHROPIC_API_KEY' },
      { name: 'openai', secretFile: 'INTERBOROUGH_SECRET_OPENAI_API_KEY' },
      { name: 'gemini', secretFile: 'INTERBOROUGH_SECRET_GEMINI_API_KEY' },
    ]);
    for (const secret of [PASSWORD, client.secretAccessKey, client.accessKeyId]) {
      expect(body).not.toContain(secret);
    }
    // What the host hands its embedder is as clean: the server, never the password.
    expect(JSON.stringify(host.database)).not.toContain(PASSWORD);
    expect(host.database.kind).toBe('postgres');
  });

  test('reads its configuration, provider key, and agents from the bucket and the environment, and writes new agents to the bucket', async () => {
    const prefix = `content/${crypto.randomUUID()}/`;
    const environment = {
      ...remoteEnvironment(await createFreshDatabaseUrl(database), server, prefix),
      INTERBOROUGH_SECRET_ANTHROPIC_API_KEY: 'fixture-anthropic-key-remote',
    };
    server.put(
      `${prefix}configuration.json`,
      JSON.stringify({ plugins: { anthropic: { configuration: { models: ['sonnet'] } } } }),
    );
    server.put(
      `${prefix}agents/researcher.md`,
      '---\nname: Researcher\nmodel: anthropic/sonnet\n---\nYou are a careful researcher.\n',
    );

    const host = await startHost({ environment, port: 0 });
    hosts.push(host);

    expect(host.bureau.agents.list().find((listing) => listing.id === 'researcher')).toMatchObject({
      source: 'file',
      state: 'ready',
      name: 'Researcher',
    });
    await host.bureau.agents.create('writer', {
      model: 'anthropic/sonnet',
      instructions: 'Write.\n',
    });
    expect(server.objects().has(`${prefix}agents/writer.md`)).toBe(true);
  });
});
