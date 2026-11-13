/**
 * COR-1892 — `bureau.agents.definitions.duplicate` copies a plugin's read-only agent into the
 * owner's agents, and the tool catalog reports where each tool comes from.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { definePlugin } from '@lostgradient/interborough-plugin';
import { createAgent } from '@lostgradient/operative';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createTool, type Tool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { agentFileDirectory } from '../../sources/agent-file-directory';
import { agentFileText, KNOWN_MODEL } from '../../testing/agent-file-fixtures.test-support';
import { callAs, disposeServed, listOf, serve } from './agent-definitions-fixtures.test-support';
import { rpc } from './management-fixtures.test-support';

const createIssue = createTool({
  name: 'linear:create-issue',
  description: 'Creates a Linear issue',
  input: z.object({}),
  metadata: { readOnly: true },
  execute: async () => 'created',
});
const tools: Readonly<Record<string, Tool>> = { 'linear:create-issue': createIssue };

const directories: string[] = [];
afterEach(async () => {
  await disposeServed();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-duplicate-'));
  directories.push(directory);
  return directory;
}

/** A Bureau over the owner's directory and the `linear` plugin's read-only layer, which ships `triager`. */
async function serveLayered() {
  const owner = await temporaryDirectory();
  const plugin = await temporaryDirectory();
  await writeFile(
    join(plugin, 'triager.md'),
    agentFileText({
      name: 'Triager',
      model: KNOWN_MODEL,
      tools: '[linear:create-issue@1.2.0]',
    }),
  );
  const served = await serve({
    directory: owner,
    overrides: {
      agentSource: [
        agentFileDirectory(owner, { tools }),
        agentFileDirectory(plugin, { plugin: 'linear', tools }),
      ],
    },
  });
  await served.bureau.agents.refresh();
  return { served, owner };
}

describe('bureau.agents.definitions.duplicate', () => {
  it('copies a plugin agent into the owner’s agents, tools unversioned, and refuses a second copy', async () => {
    const { served, owner } = await serveLayered();

    const copied = await callAs(served.owner, 'bureau.agents.definitions.duplicate', {
      id: 'linear:triager',
    });
    expect(copied.error).toBeUndefined();
    expect(copied.result).toMatchObject({ id: 'triager' });
    // COR-2231 — a copy of an agent file loses nothing.
    expect(copied.result?.['dropped']).toEqual([]);
    const text = await readFile(join(owner, 'triager.md'), 'utf8');
    expect(text).toContain('linear:create-issue');
    expect(text).not.toContain('@');

    const listed = await callAs(served.owner, 'bureau.agents.definitions.list', {});
    expect(listOf(listed, 'agents').find((entry) => entry['id'] === 'triager')).toMatchObject({
      plugin: null,
    });
    expect(
      listOf(listed, 'agents').find((entry) => entry['id'] === 'linear:triager'),
    ).toMatchObject({ plugin: 'linear' });

    const again = await callAs(served.owner, 'bureau.agents.definitions.duplicate', {
      id: 'linear:triager',
    });
    expect(again.error?.data).toMatchObject({ reason: 'agent-file-exists' });
    expect(again.result).toBeUndefined();
  });

  it('records where the copy came from, and an edit of the copy keeps it (COR-2234)', async () => {
    const { served, owner } = await serveLayered();
    const source = await callAs(served.owner, 'bureau.agents.definitions.get', {
      id: 'linear:triager',
    });
    const sourceHash = source.result?.['hash'];
    expect(typeof sourceHash).toBe('string');

    await callAs(served.owner, 'bureau.agents.definitions.duplicate', { id: 'linear:triager' });
    const text = await readFile(join(owner, 'triager.md'), 'utf8');
    expect(text).toContain(`from:\n  agent: linear:triager\n  version: ${String(sourceHash)}\n`);

    const copy = await callAs(served.owner, 'bureau.agents.definitions.get', { id: 'triager' });
    const from = { agent: 'linear:triager', version: sourceHash };
    expect(copy.result?.['definition']).toMatchObject({ from });
    // The source's version now is its file's hash; a file agent states nothing dropped.
    expect(copy.result?.['fromNow']).toBe(sourceHash);
    expect(source.result?.['dropped']).toEqual([]);
    expect(source.result?.['fromNow']).toBeNull();

    // An editor sends back the definition it read, `from` included or left out: neither changes it,
    // and a `from` a caller makes up is never written.
    const read = (copy.result?.['definition'] ?? {}) as Record<string, unknown>;
    const { from: _from, ...definition } = read;
    const omitted = await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'triager',
      expectedHash: copy.result?.['hash'],
      definition: { ...definition, description: 'Edited' },
    });
    expect(omitted.error).toBeUndefined();
    const forged = await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'triager',
      expectedHash: omitted.result?.['hash'],
      definition: {
        ...definition,
        description: 'Edited again',
        from: { agent: 'x', version: 'y' },
      },
    });
    expect(forged.error).toBeUndefined();
    const after = await callAs(served.owner, 'bureau.agents.definitions.get', { id: 'triager' });
    expect(after.result?.['definition']).toMatchObject({ description: 'Edited again', from });

    // A file that is not a copy reads `from` as null.
    expect(source.result?.['definition']).toMatchObject({ from: null });
  });

  it('refuses an agent that is not a plugin’s, and one that is not loaded', async () => {
    const { served } = await serveLayered();
    const notPlugin = await callAs(served.owner, 'bureau.agents.definitions.duplicate', {
      id: 'triager',
    });
    expect(notPlugin.error?.data?.httpStatus).toBe(400);
    const missing = await callAs(served.owner, 'bureau.agents.definitions.duplicate', {
      id: 'linear:missing',
    });
    expect(missing.error?.data?.httpStatus).toBe(404);
  });

  it('needs the write scope', async () => {
    const { served } = await serveLayered();
    const denied = await rpc(
      served.keyed,
      'bureau.agents.definitions.duplicate',
      { id: 'linear:triager' },
      'agents-reader-key',
    );
    expect(denied.error?.data?.httpStatus).toBe(403);
    const allowed = await rpc(
      served.keyed,
      'bureau.agents.definitions.duplicate',
      { id: 'linear:triager' },
      'agents-writer-key',
    );
    expect(allowed.error).toBeUndefined();
  });
});

const lookup = createTool({
  name: 'lookup',
  version: '1.0.0',
  description: 'Looks an order up',
  input: z.object({}),
  metadata: { readOnly: true },
  execute: async () => 'found',
});

const mystery = createTool({
  name: 'mystery',
  description: 'A tool no plugin contributes',
  input: z.object({}),
  execute: async () => 'unknown',
});

/**
 * A `demo` plugin, titled Demo, whose code agent `release-helper` answers from a script and names no
 * model, and whose `order-helper` calls the plugin's own `lookup` tool. Its `setup` counts its
 * runs, and its `start` records that it ran.
 */
function demoPlugin(calls: { setup: number; start: number }) {
  return definePlugin({
    name: 'demo',
    title: 'Demo',
    version: '1.0.0',
    description: 'Scripted agents.',
    enabled: false,
    setup: () => {
      calls.setup += 1;
      return {
        tools: [lookup],
        agents: [
          {
            // COR-2236 — a code agent that calls the plugin's own tool.
            name: 'order-helper',
            agent: createAgent({
              name: 'order-helper',
              instructions: 'Look the order up.',
              generate: async () => ({ content: 'Found it.', toolCalls: [] }),
              tools: { lookup },
            }),
          },
          {
            // A tool no plugin contributes: its copy is refused.
            name: 'stray-helper',
            agent: createAgent({
              name: 'stray-helper',
              generate: async () => ({ content: 'Done.', toolCalls: [] }),
              tools: { mystery },
            }),
          },
          {
            name: 'release-helper',
            agent: createAgent({
              name: 'release-helper',
              description: 'Drafts release notes from the pull requests merged since the last tag.',
              instructions: 'Draft the release notes.',
              generate: async () => ({ content: 'Here are the notes.', toolCalls: [] }),
            }),
          },
        ],
        start: () => {
          calls.start += 1;
        },
      };
    },
  });
}

async function serveDemo(enabled?: boolean, directory?: string) {
  const owner = directory ?? (await temporaryDirectory());
  const calls = { setup: 0, start: 0 };
  const served = await serve({
    directory: owner,
    overrides: {
      agentSource: agentFileDirectory(owner, { tools }),
      plugins: [{ descriptor: demoPlugin(calls), source: 'package', location: '@example/demo' }],
      ...(enabled === undefined ? {} : { pluginConfiguration: { demo: { enabled } } }),
    },
  });
  await served.bureau.plugins.ready();
  return { served, owner, calls };
}

describe('a disabled plugin’s agents (COR-2009)', () => {
  it('are listed unavailable with the reason, read like any code agent, and start no run', async () => {
    const { served, calls } = await serveDemo();
    const { bureau } = served;

    expect(bureau.agents.list().find(({ id }) => id === 'demo:release-helper')).toMatchObject({
      source: 'code',
      state: 'unavailable',
      plugin: 'demo',
      unavailable: { code: 'plugin-disabled', message: 'Plugin Demo is disabled' },
    });
    expect(bureau.agents.find('demo:release-helper')).toBeUndefined();
    expect(bureau.agents.has('demo:release-helper')).toBe(false);
    // Read once, for what its agents state; the plugin itself never started.
    expect(calls).toEqual({ setup: 1, start: 0 });

    const refused = await rejectionOf(bureau.tasks.start('demo:release-helper', 'Draft them'));
    expect(String(refused)).toContain(
      'Agent "demo:release-helper" is unavailable: Plugin Demo is disabled.',
    );

    const listed = await callAs(served.owner, 'bureau.agents.definitions.list', {});
    expect(
      listOf(listed, 'agents').find((entry) => entry['id'] === 'demo:release-helper'),
    ).toMatchObject({
      state: 'unavailable',
      plugin: 'demo',
      a2a: false,
      unavailable: { code: 'plugin-disabled', message: 'Plugin Demo is disabled' },
    });
    const detail = await callAs(served.owner, 'bureau.agents.definitions.get', {
      id: 'demo:release-helper',
    });
    expect(detail.result).toMatchObject({
      state: 'unavailable',
      unavailable: { message: 'Plugin Demo is disabled' },
      codeDefinition: {
        name: 'release-helper',
        description: 'Drafts release notes from the pull requests merged since the last tag.',
        instructions: 'Draft the release notes.',
        model: null,
      },
    });
    // The agents a caller can start leave it out.
    const startable = await callAs(served.owner, 'bureau.agents.list', {});
    expect(listOf(startable, 'agents').map((entry) => entry['name'])).not.toContain(
      'demo:release-helper',
    );
  });

  it('duplicates into an agent file you own, which runs and can be edited', async () => {
    const { served, owner } = await serveDemo();
    const { bureau } = served;

    const copied = await callAs(served.owner, 'bureau.agents.definitions.duplicate', {
      id: 'demo:release-helper',
    });
    expect(copied.error).toBeUndefined();
    // COR-2231 — the scripted `generate` is what the copy loses.
    expect(copied.result).toMatchObject({ id: 'release-helper', dropped: ['generate'] });
    const text = await readFile(join(owner, 'release-helper.md'), 'utf8');
    // A scripted agent names no model, so the copy takes the first one the catalog offers, and a
    // file must name one.
    expect(text).toMatch(/^model: [a-z]+\/[\w.-]+$/mu);
    expect(text).toContain('Draft the release notes.');
    // COR-2234: the Bureau holds no version for a disabled plugin's agent, so its copy records none.
    expect(text).not.toContain('from:');

    await bureau.agents.refresh();
    expect(bureau.agents.list().find(({ id }) => id === 'release-helper')).toMatchObject({
      source: 'file',
      state: 'ready',
    });
    expect(bureau.agents.find('release-helper')).toBeDefined();
    const edited = await bureau.agents.update(
      'release-helper',
      { model: KNOWN_MODEL, instructions: 'Draft shorter notes.' },
      { expectedHash: served.hashOf('release-helper') },
    );
    expect(edited.id).toBe('release-helper');
    // The original stays unavailable.
    expect(bureau.agents.list().find(({ id }) => id === 'demo:release-helper')?.state).toBe(
      'unavailable',
    );

    const again = await callAs(served.owner, 'bureau.agents.definitions.duplicate', {
      id: 'demo:release-helper',
    });
    expect(again.error?.data).toMatchObject({ reason: 'agent-file-exists' });
  });

  it('keeps the disabled plugin’s own tools in the copy, which is needs-setup until the plugin is enabled (COR-2236)', async () => {
    const { served, owner } = await serveDemo();

    const copied = await callAs(served.owner, 'bureau.agents.definitions.duplicate', {
      id: 'demo:order-helper',
    });
    expect(copied.error).toBeUndefined();
    expect(copied.result).toMatchObject({ id: 'order-helper' });
    expect(await readFile(join(owner, 'order-helper.md'), 'utf8')).toContain('demo:lookup');

    await served.bureau.agents.refresh();
    expect(served.bureau.agents.list().find(({ id }) => id === 'order-helper')).toMatchObject({
      source: 'file',
      state: 'invalid',
      problem: { code: 'needs-setup', issues: [{ reference: 'demo:lookup' }] },
    });
    expect(served.bureau.agents.find('order-helper')).toBeUndefined();

    // The plugin is enabled in a Bureau over the same agents: the copy runs.
    await disposeServed();
    const enabled = await serveDemo(true, owner);
    await enabled.served.bureau.agents.refresh();
    expect(
      enabled.served.bureau.agents.list().find(({ id }) => id === 'order-helper'),
    ).toMatchObject({ source: 'file', state: 'ready' });
    expect(enabled.served.bureau.agents.find('order-helper')).toBeDefined();
  });

  it('still refuses a copy that names a tool no plugin contributes, writing nothing (COR-2236)', async () => {
    const { served, owner } = await serveDemo();
    const refused = await callAs(served.owner, 'bureau.agents.definitions.duplicate', {
      id: 'demo:stray-helper',
    });
    expect(refused.error?.data).toMatchObject({ reason: 'unknown-tool' });
    expect(refused.result).toBeUndefined();
    expect(await Bun.file(join(owner, 'stray-helper.md')).exists()).toBe(false);
  });

  it('are available again once the plugin is enabled', async () => {
    const { served, calls } = await serveDemo(true);
    const { bureau } = served;
    expect(bureau.agents.list().find(({ id }) => id === 'demo:release-helper')).toEqual(
      expect.objectContaining({ state: 'ready' }),
    );
    expect(
      bureau.agents.list().find(({ id }) => id === 'demo:release-helper')?.unavailable,
    ).toBeUndefined();
    expect(bureau.agents.has('demo:release-helper')).toBe(true);
    expect(calls).toEqual({ setup: 1, start: 1 });
    const run = await bureau.tasks.start('demo:release-helper', 'Draft them');
    expect(run.id).toBeString();
  });

  it('states what a copy loses before any write, records the plugin’s version, and answers the source’s version now (COR-2232, COR-2234)', async () => {
    const { served, owner } = await serveDemo(true);
    const before = await callAs(served.owner, 'bureau.agents.definitions.get', {
      id: 'demo:release-helper',
    });
    // The same list the duplicate answers, and nothing was written to read it.
    expect(before.result?.['dropped']).toEqual(['generate']);
    expect(await rejectionOf(readFile(join(owner, 'release-helper.md'), 'utf8'))).toBeInstanceOf(
      Error,
    );
    const orderHelper = await callAs(served.owner, 'bureau.agents.definitions.get', {
      id: 'demo:order-helper',
    });
    expect(orderHelper.result?.['dropped']).toEqual(['generate']);

    const copied = await callAs(served.owner, 'bureau.agents.definitions.duplicate', {
      id: 'demo:release-helper',
    });
    expect(copied.result?.['dropped']).toEqual(before.result?.['dropped']);
    const text = await readFile(join(owner, 'release-helper.md'), 'utf8');
    expect(text).toContain('from:\n  agent: demo:release-helper\n  version: 1.0.0\n');

    await served.bureau.agents.refresh();
    const copy = await callAs(served.owner, 'bureau.agents.definitions.get', {
      id: 'release-helper',
    });
    expect(copy.result?.['definition']).toMatchObject({
      from: { agent: 'demo:release-helper', version: '1.0.0' },
    });
    expect(copy.result?.['fromNow']).toBe('1.0.0');
    expect(copy.result?.['dropped']).toEqual([]);
    expect(before.result?.['fromNow']).toBeNull();
  });
});

describe('the tool catalog’s source', () => {
  it('reports a plugin’s tool as the plugin’s, Bureau’s own as Bureau’s, and the host’s as the host’s', async () => {
    const owner = await temporaryDirectory();
    const served = await serve({
      directory: owner,
      overrides: {
        agentSource: agentFileDirectory(owner, { tools }),
        plugins: [
          {
            descriptor: definePlugin({
              name: 'p',
              version: '1.0.0',
              description: 'Contributes t.',
              setup: () => ({
                tools: [
                  createTool({
                    name: 't',
                    description: 'Does t',
                    input: z.object({}),
                    execute: async () => 'done',
                  }),
                ],
              }),
            }),
            source: 'package',
            location: '@example/p',
          },
        ],
      },
    });
    const response = await callAs(served.owner, 'bureau.agents.catalog', {});
    const byName = Object.fromEntries(
      listOf(response, 'tools').map((tool) => [String(tool['name']), tool]),
    );
    expect(byName['p:t']).toMatchObject({ source: 'plugin', plugin: 'p' });
    expect(byName['bureau:discover-agents']).toMatchObject({ source: 'bureau', plugin: null });
    expect(byName['settings-update']).toMatchObject({ source: 'bureau', plugin: null });
    expect(byName['linear:create-issue']).toMatchObject({ source: 'host', plugin: null });
  });
});
