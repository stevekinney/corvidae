/**
 * The host's agent directory (COR-1524): Markdown files in Bungalow's `agents/` directory are
 * agents of the Bureau. A file's model is a row of the host's catalog, so it runs with the key in
 * the secrets; the provider path here runs against a fake client, and the secret is a fixture.
 */
import { openBungalow } from '@lostgradient/bungalow';
import { resolveProviderGenerate, type ProviderConfiguration } from '@lostgradient/bureau';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host, type HostOptions } from './host.ts';

const FIXTURE_KEY = 'fixture-anthropic-key-9c1d';
const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function prepareHome(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-agents-'));
  directories.push(home);
  await writeFile(
    join(home, 'configuration.json'),
    JSON.stringify({ providers: { anthropic: { models: ['sonnet'] } } }),
  );
  const bungalow = openBungalow({ name: 'interborough', environment: { INTERBOROUGH_HOME: home } });
  try {
    bungalow.writeSecret('anthropic-api-key', FIXTURE_KEY);
  } finally {
    bungalow.close();
  }
  if (Object.keys(files).length > 0) {
    await mkdir(join(home, 'agents'), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      await writeFile(join(home, 'agents', name), text);
    }
  }
  return home;
}

async function startAt(home: string, options: HostOptions = {}): Promise<Host> {
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    seed: false,
    ...options,
  });
  hosts.push(host);
  return host;
}

/** A provider path whose client answers every request with `reply`, recording what it was handed. */
function fakeProvider(reply: string) {
  const handed: ProviderConfiguration[] = [];
  const client = {
    messages: {
      create: async () => ({
        id: 'message-1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: reply }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 5 },
      }),
    },
  };
  const resolver: NonNullable<HostOptions['resolveProviderGenerate']> = (
    provider,
    streamEventTarget,
  ) => {
    handed.push(provider);
    return resolveProviderGenerate(Object.assign({}, provider, { client }), streamEventTarget);
  };
  return { handed, resolver };
}

const RESEARCHER = [
  '---',
  'name: Researcher',
  'model: anthropic/sonnet',
  'tools: [lookup-order]',
  '---',
  'You are a careful researcher.',
  '',
].join('\n');

describe('the host’s agent directory', () => {
  test('is the agents directory under the Interborough home, created on start', async () => {
    const home = await prepareHome();
    const host = await startAt(home);
    expect(host.bureau.agents.list().map((listing) => listing.id)).toEqual([
      'assistant',
      'tool-runner',
      'request-human-input',
      'echo',
      'model-switcher',
      'internal',
    ]);
    const created = await host.bureau.agents.create('writer', {
      model: 'anthropic/sonnet',
      instructions: 'Write.\n',
    });
    expect(created.id).toBe('writer');
    expect(await Bun.file(join(home, 'agents', 'writer.md')).exists()).toBe(true);
  });

  test('loads a file at start and runs it with the model’s key from the secrets', async () => {
    const { handed, resolver } = fakeProvider('A reply from a file agent.');
    const home = await prepareHome({ 'researcher.md': RESEARCHER });
    const host = await startAt(home, { resolveProviderGenerate: resolver });

    expect(host.bureau.agents.list().find((listing) => listing.id === 'researcher')).toMatchObject({
      source: 'file',
      state: 'ready',
      name: 'Researcher',
      owner: 'anonymous:local',
    });
    const result = await host.bureau.run('researcher', 'Hello').result();
    expect(result.content).toBe('A reply from a file agent.');
    expect(handed.at(-1)).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5' });
    // Compared, not printed: a failure must not show the value.
    expect(handed.at(-1)?.apiKey === FIXTURE_KEY).toBe(true);
  });

  test('runs a file agent as a session run too', async () => {
    const { handed, resolver } = fakeProvider('Session reply.');
    const home = await prepareHome({ 'researcher.md': RESEARCHER });
    const host = await startAt(home, { resolveProviderGenerate: resolver });
    const created = await host.bureau.createRun({ message: 'Hello', agentName: 'researcher' });
    const outcome = await host.bureau.waitForDurableRun(created.id);
    expect(outcome).toBeDefined();
    const session = await host.bureau.getSession(created.sessionId);
    expect(session?.agentName).toBe('researcher');
    expect(handed.at(-1)).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5' });
  });

  test('lists a file whose provider has no key as invalid, and one that names an unknown tool', async () => {
    const home = await prepareHome({
      'keyless.md': '---\nmodel: openai/gpt-4.1\n---\nHi.\n',
      'refunder.md': '---\nmodel: anthropic/sonnet\ntools: [issue-refund]\n---\nHi.\n',
    });
    const host = await startAt(home);
    const byId = Object.fromEntries(
      host.bureau.agents.list().map((listing) => [listing.id, listing]),
    );
    expect(byId['keyless']).toMatchObject({ state: 'invalid', problem: { code: 'unknown-model' } });
    expect(byId['refunder']).toMatchObject({ state: 'invalid', problem: { code: 'unknown-tool' } });
  });

  test('picks up an added file without a restart', async () => {
    const home = await prepareHome();
    const host = await startAt(home);
    const added = new Promise<string[]>((resolve) => {
      const stop = host.bureau.agents.onChange((change) => {
        if (!change.added.includes('late')) return;
        stop();
        resolve([...change.added]);
      });
    });
    await mkdir(join(home, 'agents'), { recursive: true });
    await writeFile(join(home, 'agents', 'late.md'), RESEARCHER);
    expect(await added).toContain('late');
    expect(host.bureau.agents.list().find((listing) => listing.id === 'late')?.state).toBe('ready');
  });

  test('cannot take the name of a seeded agent', async () => {
    const home = await prepareHome({ 'assistant.md': RESEARCHER });
    const host = await startAt(home);
    const listings = host.bureau.agents.list().filter((listing) => listing.id === 'assistant');
    expect(listings.map((listing) => [listing.source, listing.state])).toEqual([
      ['code', 'ready'],
      ['file', 'invalid'],
    ]);
  });
});
