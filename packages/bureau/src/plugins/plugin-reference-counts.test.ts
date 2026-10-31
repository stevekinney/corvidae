/**
 * COR-1879 — `plugins.list()` counts, for each contribution, the agents whose definition names it,
 * the schedules that run it or one of those agents, and the runs waiting on a review that are of
 * it, of one of those agents, or an approval of it. Every read counts afresh.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { definePlugin } from '@lostgradient/interborough-plugin';
import { createAgent } from '@lostgradient/operative';
import { createTool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { agentFileDirectory } from '../sources/agent-file-directory';
import { agentFileText, KNOWN_MODEL } from '../testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from '../testing/agent-file-bureau.test-support';
import type { PluginContributionReferences } from './plugin-types';
import { listedPlugins } from '../testing/plugin-listing.test-support';

const roots: string[] = [];
const harnesses: FileBureauHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Plugin `p`: a mutating tool, a guardrail, a run hook set and a code agent. */
const plugin = definePlugin({
  name: 'p',
  version: '1.0.0',
  description: 'Contributes one of each kind an agent or a schedule names.',
  setup: () => ({
    tools: [
      createTool({
        name: 't',
        description: 'Changes something',
        input: z.object({ item: z.string() }),
        metadata: { mutates: true },
        execute: async ({ item }) => ({ changed: item }),
      }),
    ],
    guardrails: {
      inputDetectors: [
        {
          name: 'scan',
          detect: async () => ({ triggered: false, confidence: 0, category: 'clean' }),
        },
      ],
    },
    runHooks: [{ name: 'audit', onStep: async () => undefined }],
    codeAgents: [
      {
        name: 'writer',
        agent: createAgent({ generate: async () => ({ content: 'done', toolCalls: [] }) }),
      },
    ],
  }),
});

const none: PluginContributionReferences = { agents: 0, schedules: 0, waitingRuns: 0 };

describe('the references plugins.list() counts for each contribution', () => {
  it('counts the agents, schedules and waiting runs that name each contribution, afresh on every read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bureau-plugin-references-'));
    roots.push(directory);
    let asked = false;
    const harness = await startFileBureau({
      directory,
      scripts: {
        [KNOWN_MODEL.split('/')[1] as string]: () => {
          if (asked) return 'Done.';
          asked = true;
          return { content: '', toolCalls: [{ name: 'p__t', arguments: { item: 'x' } }] };
        },
      },
      overrides: {
        agentApprovalSecret: 'plugin-reference-secret',
        agentSource: agentFileDirectory(directory),
        plugins: [{ descriptor: plugin, source: 'package', location: '@example/p' }],
      },
    });
    harnesses.push(harness);
    const { bureau } = harness;
    const counts = async () => {
      const [listing] = await listedPlugins(bureau);
      return Object.fromEntries(
        (listing?.contributions ?? []).map(({ id, references }) => [id, references]),
      );
    };

    expect(await counts()).toEqual({
      'p:t@1.0.0': none,
      'p:scan': none,
      'p:audit': none,
      'p:writer': none,
    });

    await harness.put('helper.md', agentFileText({ model: KNOWN_MODEL, tools: '[p:t]' }));
    await harness.put(
      'guarded.md',
      agentFileText({ model: KNOWN_MODEL, guardrails: '[p:scan]', hooks: '[p:audit]' }),
    );
    await bureau.agents.refresh();
    const helperSchedule = await bureau.schedules.create({
      agentName: 'helper',
      input: 'Daily.',
      spec: '1d',
    });
    await bureau.schedules.create({ agentName: 'guarded', input: 'Daily.', spec: '1d' });
    await bureau.schedules.create({ agentName: 'p:writer', input: 'Daily.', spec: '1d' });
    // A run of `helper` waits on an approval of `p:t`.
    const task = await bureau.tasks.start('helper', 'Go.');
    await task.result();
    expect(bureau.reviews.list().map(({ kind }) => kind)).toEqual(['tool-approval']);

    expect(await counts()).toEqual({
      'p:t@1.0.0': { agents: 1, schedules: 1, waitingRuns: 1 },
      'p:scan': { agents: 1, schedules: 1, waitingRuns: 0 },
      'p:audit': { agents: 1, schedules: 1, waitingRuns: 0 },
      'p:writer': { agents: 0, schedules: 1, waitingRuns: 0 },
    });

    // A cancelled schedule and a decided review no longer count, on the very next read.
    await bureau.schedules.cancel(helperSchedule!.id);
    await bureau.reviews.resolve({
      id: bureau.reviews.list()[0]!.id,
      decision: 'deny',
      principal: 'api-key:approver',
    });
    const after = await counts();
    expect(after['p:t@1.0.0']).toEqual({ agents: 1, schedules: 0, waitingRuns: 0 });
  });
});
