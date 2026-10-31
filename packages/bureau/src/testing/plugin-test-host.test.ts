/**
 * COR-1883 — the conformance suite over a real Bureau: a plugin that ships a valid agent file
 * passes, and one whose file names a contribution nothing holds fails on `reference-unresolved`.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { definePlugin } from '@lostgradient/interborough-plugin';
import { checkPluginContract, pluginContract } from '@lostgradient/interborough-plugin/testing';
import { createTool } from 'armorer';
import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { agentFileText, KNOWN_MODEL } from './agent-file-fixtures.test-support.ts';
import { createPluginTestHost } from './plugin-test-host.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** A plugin `p` with one tool, shipping one agent file that names the tools it lists. */
async function pluginShipping(tools: string, extra: Record<string, unknown> = {}) {
  const content = await mkdtemp(join(tmpdir(), 'bureau-plugin-content-'));
  roots.push(content);
  await mkdir(join(content, 'agents'));
  await writeFile(
    join(content, 'agents', 'triager.md'),
    agentFileText({ model: KNOWN_MODEL, tools }),
  );
  return definePlugin({
    name: 'p',
    version: '1.0.0',
    description: 'Ships a triager.',
    content: pathToFileURL(`${content}/`),
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
    ...extra,
  });
}

const valid = await pluginShipping('[p:lookup]');
pluginContract(valid, { createHost: createPluginTestHost });

describe('checkPluginContract over a Bureau', () => {
  test('passes a plugin whose shipped agent file resolves', async () => {
    expect(await checkPluginContract(valid, { createHost: createPluginTestHost })).toEqual([]);
  });

  test('fails a plugin whose shipped agent file names a contribution nothing holds', async () => {
    const unresolved = await pluginShipping('[p:lookup, p:absent]');
    const failures = await checkPluginContract(unresolved, { createHost: createPluginTestHost });
    expect(failures).toEqual([
      {
        check: 'reports no problems',
        message: JSON.stringify({
          code: 'reference-unresolved',
          file: 'p:triager',
          id: 'p:absent',
        }),
      },
    ]);
  });

  test('gives every declared secret a value, so the plugin runs', async () => {
    const needsSecret = await pluginShipping('[p:lookup]', { secrets: ['p-api-key'] });
    expect(await checkPluginContract(needsSecret, { createHost: createPluginTestHost })).toEqual(
      [],
    );
  });

  test('refuses a descriptor that is not valid before the host starts', async () => {
    const malformed = { name: 'Not A Name', version: '1.0.0', description: 'bad' };
    const failures = await checkPluginContract(malformed, { createHost: createPluginTestHost });
    expect(failures[0]?.check).toBe('declares a valid descriptor');
  });
});
