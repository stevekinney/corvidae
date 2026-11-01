/**
 * COR-1892 — `bureau.agents.definitions.duplicate` copies a plugin's read-only agent into the
 * owner's agents, and the tool catalog reports where each tool comes from.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { definePlugin } from '@lostgradient/interborough-plugin';
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
