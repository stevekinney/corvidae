/**
 * The Workflows area's data functions against a host composed the way production composes it: no
 * `createConsoleEngine`, so the console's engine is the Bureau's durable engine and the Bureau's
 * workflow files are the engine's sources. The component tests stand stubs in for both services and
 * the Playwright host serves its console from a second engine, so this is the one test that holds
 * the join (`lib/workflow-catalog.ts`) to what the real services answer: the list, an agent-authored
 * definition, the schedules that start a type, a signal that moves a run to completion, the
 * versions that have run, and a deleted file that the engine still holds as a source.
 */
import { HttpClient } from '@lostgradient/weft';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Fetcher } from '../lib/bureau-client.ts';
import { urlOf } from '../lib/bureau-stub.test-support.ts';
import {
  getDefinition,
  listDefinitions,
  loadCatalog,
  resolveWorkflow,
  startingSchedules,
} from '../lib/workflow-catalog.ts';
import {
  deleteWorkflowFile,
  getWorkflowFile,
  listWorkflowRevisions,
  pauseWorkflowFile,
  signalWorkflows,
} from '../lib/workflow-files.ts';
import { startHost, type Host } from './host.ts';

const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const FILES = {
  digest: {
    name: 'digest',
    agent: 'assistant',
    trigger: { kind: 'schedule', spec: '24h' },
    steps: [{ kind: 'activity', handler: 'agent', input: { agent: 'assistant', message: 'Hi' } }],
  },
  approval: {
    name: 'approval',
    agent: 'assistant',
    trigger: { kind: 'signal', name: 'catalog-go' },
    steps: [{ kind: 'await-signal', signal: 'catalog-approve' }],
  },
  broken: { name: 'broken', trigger: { kind: 'schedule', spec: 'nope' }, steps: [] },
};

async function start(): Promise<{ host: Host; client: HttpClient; options: { fetch: Fetcher } }> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-catalog-'));
  directories.push(home);
  await mkdir(join(home, 'workflows'), { recursive: true });
  for (const [id, document] of Object.entries(FILES)) {
    await writeFile(
      join(home, 'workflows', `${id}.json`),
      `${JSON.stringify(document, null, 2)}\n`,
    );
  }
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0, seed: false });
  hosts.push(host);
  const fetcher: Fetcher = (input, init) => fetch(new URL(urlOf(input), host.url), init);
  return {
    host,
    client: new HttpClient({ baseUrl: host.url.toString() }),
    options: { fetch: fetcher },
  };
}

describe('the Workflows data, against the production composition', () => {
  test('serves the console from the Bureau’s own engine, so the Bureau’s files are its sources', async () => {
    const { host, client } = await start();
    expect(host.engine === host.bureau.durableEngine()).toBe(true);
    const definitions = await listDefinitions(client);
    const sources = definitions.filter((definition) => definition.origin === 'source');
    expect(sources.map((definition) => definition.name).toSorted()).toEqual(['approval', 'digest']);
  });

  test('lists each file as agent-authored with its agent, an invalid file with its problem, and no source without a file', async () => {
    const { client, options } = await start();
    const rows = await loadCatalog(client, options);
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    expect(byName['digest']).toMatchObject({
      kind: 'agent-authored',
      agent: 'assistant',
      failure: null,
    });
    expect(byName['approval']?.kind).toBe('agent-authored');
    expect(byName['broken']?.file?.state).toBe('invalid');
    expect(byName['broken']?.problem?.code).toBe('invalid-document');
    // The Bureau's own types are the engine's code-defined ones, and none is agent-authored.
    expect(rows.filter((row) => row.kind === 'code').every((row) => row.file === null)).toBe(true);
  });

  test('resolves a file to its source definition, and an invalid file to none', async () => {
    const { client, options } = await start();
    const digest = await resolveWorkflow(client, 'digest', options);
    if (digest?.kind !== 'agent-authored') throw new Error('expected an agent-authored type');
    expect(digest.definition?.origin).toBe('source');
    expect(digest.definition?.state).toBe('ready');
    const broken = await resolveWorkflow(client, 'broken', options);
    if (broken?.kind !== 'agent-authored') throw new Error('expected an agent-authored type');
    expect(broken.definition).toBeUndefined();
    expect(await resolveWorkflow(client, 'nobody', options)).toBeUndefined();
    // A name the engine refuses before it looks is a missing type too.
    expect(await resolveWorkflow(client, 'foo.bar', options)).toBeUndefined();
  });

  test('lists the one schedule that starts a type, and a pause keeps it as the same schedule', async () => {
    const { client, options } = await start();
    const beforePage = await client.listSchedules({ workflowType: 'digest' });
    const before = startingSchedules(beforePage.items);
    expect(before.map((schedule) => schedule.status)).toEqual(['active']);
    const file = await getWorkflowFile('digest', options);
    if (file.hash === null) throw new Error('The file has no hash.');
    await pauseWorkflowFile('digest', file.hash, options);
    const afterPage = await client.listSchedules({ workflowType: 'digest' });
    const after = startingSchedules(afterPage.items);
    expect(after.map((schedule) => schedule.id)).toEqual(before.map((schedule) => schedule.id));
    expect(after.map((schedule) => schedule.status)).toEqual(['paused']);
  });

  test('starts an instance with a signal, lists it by type, and completes it with the signal it awaits', async () => {
    const { client, options } = await start();
    const started = await signalWorkflows({ name: 'catalog-go' }, options);
    expect(started.started).toHaveLength(1);
    const runId = started.started[0] ?? '';
    const runs = await client.list({ type: 'approval' });
    expect(runs.items.map((run) => run.id)).toContain(runId);

    // The instance waits at its step once it has started; a signal sent before that reaches no one.
    let status = '';
    for (let attempt = 0; attempt < 200 && status !== 'completed'; attempt += 1) {
      await signalWorkflows({ name: 'catalog-approve', payload: { ok: true } }, options);
      const run = await client.get(runId);
      status = run?.status ?? '';
    }
    expect(status).toBe('completed');
    const revisions = await listWorkflowRevisions('approval', options);
    expect(revisions).toHaveLength(1);
  });

  test('a deleted file is not found while the engine still holds its source, and leaves the list', async () => {
    const { client, options } = await start();
    const file = await getWorkflowFile('approval', options);
    if (file.hash === null) throw new Error('The file has no hash.');
    await deleteWorkflowFile('approval', file.hash, options);
    // Before a restart the engine still answers for it, as a source.
    const held = await getDefinition(client, 'approval');
    expect(held?.origin).toBe('source');
    expect(await resolveWorkflow(client, 'approval', options)).toBeUndefined();
    const rows = await loadCatalog(client, options);
    expect(rows.some((row) => row.name === 'approval')).toBe(false);
  });
});
