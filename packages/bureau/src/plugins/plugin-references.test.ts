/**
 * COR-1879 — a file a running plugin ships that names a contribution nothing loaded holds is that
 * plugin's `reference-unresolved`, and the plugin keeps running.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { definePlugin } from '@lostgradient/interborough-plugin';
import { createTool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { agentFileDirectory } from '../sources/agent-file-directory';
import { layeredAgentSource } from '../sources/layered-source';
import { agentFileText, KNOWN_MODEL } from '../testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from '../testing/agent-file-bureau.test-support';

const roots: string[] = [];
const harnesses: FileBureauHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('a plugin file naming an absent contribution', () => {
  it('is invalid, reported on its plugin as reference-unresolved with file and id, and the plugin keeps running', async () => {
    const owner = await mkdtemp(join(tmpdir(), 'bureau-plugin-owner-'));
    const shipped = await mkdtemp(join(tmpdir(), 'bureau-plugin-files-'));
    roots.push(owner, shipped);
    await writeFile(
      join(shipped, 'triager.md'),
      agentFileText({ model: KNOWN_MODEL, tools: '[p:lookup, p:absent]' }),
    );
    await writeFile(
      join(shipped, 'reader.md'),
      agentFileText({ model: KNOWN_MODEL, tools: '[p:lookup]' }),
    );
    const plugin = definePlugin({
      name: 'p',
      version: '1.0.0',
      description: 'Ships a triager.',
      setup: () => ({
        tools: [
          createTool({
            name: 'lookup',
            description: 'Looks up',
            input: z.object({}),
            execute: async () => 'found',
          }),
        ],
      }),
    });
    const harness = await startFileBureau({
      directory: owner,
      overrides: {
        agentSource: layeredAgentSource([
          agentFileDirectory(owner),
          agentFileDirectory(shipped, { plugin: 'p' }),
        ]),
        plugins: [{ descriptor: plugin, source: 'package', location: '@example/p' }],
      },
    });
    harnesses.push(harness);

    const triager = harness.bureau.agents.list().find(({ id }) => id === 'p:triager');
    expect(triager?.state).toBe('invalid');
    expect(harness.bureau.agents.list().find(({ id }) => id === 'p:reader')?.state).toBe('ready');
    const [listing] = harness.bureau.plugins.list();
    expect(listing?.status).toBe('running');
    expect(listing?.problems).toEqual([
      { code: 'reference-unresolved', file: 'p:triager', id: 'p:absent' },
    ]);
  });
});
