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
async function pluginShipping(
  tools: string,
  extra: Record<string, unknown> = {},
  model: string = KNOWN_MODEL,
) {
  const content = await mkdtemp(join(tmpdir(), 'bureau-plugin-content-'));
  roots.push(content);
  await mkdir(join(content, 'agents'));
  await writeFile(join(content, 'agents', 'triager.md'), agentFileText({ model, tools }));
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

  test('enables the plugin under test even when it is off by default', async () => {
    const optIn = await pluginShipping('[p:lookup]', { enabledByDefault: false });
    expect(await checkPluginContract(optIn, { createHost: createPluginTestHost })).toEqual([]);
  });

  test('fails a plugin whose shipped agent names a model nothing holds', async () => {
    const unknownModel = await pluginShipping('[p:lookup]', {}, 'anthropic/no-such-model');
    const failures = await checkPluginContract(unknownModel, {
      createHost: createPluginTestHost,
    });
    expect(failures.map(({ check }) => check)).toEqual(['ships only valid agent files']);
    expect(failures[0]?.message).toContain('p:triager');
    expect(failures[0]?.message).toContain('unknown-model');
  });

  test('refuses a descriptor that is not valid before the host starts', async () => {
    const malformed = { name: 'Not A Name', version: '1.0.0', description: 'bad' };
    const failures = await checkPluginContract(malformed, { createHost: createPluginTestHost });
    expect(failures[0]?.check).toBe('declares a valid descriptor');
  });
});

const HOOK_CHECK = 'runs every declared hook point without throwing';

/** Every point of an interceptor, as the declared set a plugin under test would hold. */
const EVERY_POINT = [
  'prepareStep',
  'beforeToolExecution',
  'afterToolExecution',
  'onStep',
  'selectTools',
  'validateResponse',
  'validateToolResult',
  'beforeCompaction',
  'beforeBackgroundCompaction',
  'afterCompaction',
  'selectToolChoice',
  'beforeGenerate',
  'afterGenerate',
  'onLLMInput',
  'onLLMOutput',
  'onRunStart',
  'onRunComplete',
  'onRunError',
  'onRunAbort',
  'onError',
] as const;

/** A plugin whose one interceptor declares `points`, each recording into `ran` when it runs. */
function pluginRecording(points: readonly (typeof EVERY_POINT)[number][], ran: Set<string>) {
  const hooks = Object.fromEntries(
    points.map((point) => [
      point,
      {
        handler: async () => {
          ran.add(point);
          return undefined;
        },
        replay: 'safe' as const,
      },
    ]),
  );
  return definePlugin({
    name: 'probe',
    version: '1.0.0',
    description: 'Records which hook points run.',
    setup: () => ({ interceptors: [{ name: 'probe', ...hooks }] }),
  });
}

describe('PluginTestHost.scriptedRun', () => {
  test('reaches every hook point but compaction and abort across its three scenarios', async () => {
    const ran = new Set<string>();
    const host = await createPluginTestHost(pluginRecording(EVERY_POINT, ran));
    try {
      await host.plugins.ready();
      const reached = new Map<string, readonly string[]>();
      for (const scenario of ['answer', 'tool', 'failure'] as const) {
        ran.clear();
        const outcome = await host.scriptedRun({ scenario, interceptors: ['probe'] });
        expect(outcome.finishReason).toBe(scenario === 'failure' ? 'error' : 'stop-condition');
        reached.set(scenario, [...ran].toSorted());
      }
      const union = new Set([...reached.values()].flat());
      // The documented unchecked list is exactly what no scenario reaches.
      expect(EVERY_POINT.filter((point) => !union.has(point)).toSorted()).toEqual([
        'afterCompaction',
        'beforeBackgroundCompaction',
        'beforeCompaction',
        'onRunAbort',
      ]);
      expect(reached.get('tool')).toEqual(
        expect.arrayContaining(['afterToolExecution', 'beforeToolExecution', 'validateToolResult']),
      );
      expect(reached.get('answer')).not.toContain('beforeToolExecution');
      expect(reached.get('failure')).toEqual(expect.arrayContaining(['onError', 'onRunError']));
      expect(reached.get('failure')).not.toContain('onStep');
    } finally {
      await host.dispose();
    }
  });

  test('runs a set that applies to no agent too, because the scripted agent chooses it', async () => {
    const ran = new Set<string>();
    const chosen = definePlugin({
      name: 'chosen',
      version: '1.0.0',
      description: 'A set an agent file must list.',
      setup: () => ({
        interceptors: [
          {
            name: 'listed',
            onStep: async () => {
              ran.add('onStep');
            },
          },
        ],
      }),
    });
    const host = await createPluginTestHost(chosen);
    try {
      await host.plugins.ready();
      await host.scriptedRun({ scenario: 'answer', interceptors: ['listed'] });
      expect([...ran]).toEqual(['onStep']);
      ran.clear();
      await host.scriptedRun({ scenario: 'answer', interceptors: [] });
      expect([...ran]).toEqual([]);
    } finally {
      await host.dispose();
    }
  });
});

describe('the hook points the contract runs, over a Bureau', () => {
  test('passes a plugin whose declared hooks run, and starts one run for each point', async () => {
    const ran = new Set<string>();
    const recording = pluginRecording(['onStep', 'beforeToolExecution', 'onRunError'], ran);
    expect(await checkPluginContract(recording, { createHost: createPluginTestHost })).toEqual([]);
  });

  test('fails a plugin whose declared onStep throws, though its own onError would continue', async () => {
    const throwing = definePlugin({
      name: 'throws',
      version: '1.0.0',
      description: 'Its onStep always throws.',
      setup: () => ({
        interceptors: [
          {
            name: 'audit',
            appliesTo: 'every-agent' as const,
            onStep: {
              handler: async () => {
                throw new Error('the step could not be recorded');
              },
              replay: 'effectful' as const,
              onError: () => 'continue' as const,
            },
          },
        ],
      }),
    });
    const failures = await checkPluginContract(throwing, { createHost: createPluginTestHost });
    expect(failures).toEqual([
      {
        check: HOOK_CHECK,
        message: 'The onStep hook of "audit" threw: the step could not be recorded',
      },
    ]);
  });

  test('fails a plugin whose bare onStep throws, which also ends the scripted run in an error', async () => {
    const bare = definePlugin({
      name: 'bare',
      version: '1.0.0',
      description: 'Its onStep is a bare function that throws.',
      setup: () => ({
        interceptors: [
          {
            name: 'audit',
            appliesTo: 'every-agent' as const,
            onStep: async () => {
              throw new Error('no storage');
            },
          },
        ],
      }),
    });
    const host = await createPluginTestHost(bare);
    try {
      await host.plugins.ready();
      expect(await host.scriptedRun({ scenario: 'answer', interceptors: ['audit'] })).toEqual({
        finishReason: 'error',
      });
    } finally {
      await host.dispose();
    }
    expect(await checkPluginContract(bare, { createHost: createPluginTestHost })).toEqual([
      { check: HOOK_CHECK, message: 'The onStep hook of "audit" threw: no storage' },
    ]);
  });

  test('does not run a hook declared where the scripted host cannot reach, and does not fail it', async () => {
    const ran = new Set<string>();
    const unreachable = pluginRecording(['onRunAbort', 'beforeCompaction'], ran);
    expect(await checkPluginContract(unreachable, { createHost: createPluginTestHost })).toEqual(
      [],
    );
    expect([...ran]).toEqual([]);
  });
});
