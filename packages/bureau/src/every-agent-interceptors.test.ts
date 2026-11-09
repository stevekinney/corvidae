/**
 * COR-2127 — a plugin interceptor that declares `appliesTo: 'every-agent'` registers for every run
 * Bureau composes, whether or not the run's agent lists it, in a `plugin` tier between `bureau`
 * and `agent`.
 *
 * Outcome matrix, one test (or one table row) each:
 *
 * | run kind | every-agent set | result |
 * | -- | -- | -- |
 * | file agent not listing it | `onStep` set | fires once per step |
 * | code agent | same | fires |
 * | catalog dispatch (`bureau.children.dispatch`) | same | fires |
 * | child of a Bureau-owned run (a subagent tool) | same | fires |
 * | file agent listing the same set | same | registers once, so fires once per step |
 * | plugin `needs-setup` | same | skipped: the other agents' steps succeed and the set does not run |
 *
 * The plan-level rows (tiers, bands, Bureau's pinned-last entries, a resumed durable run) are in
 * `run-hook-tiers.test.ts`.
 */
import { definePlugin, type PluginInterceptor } from '@lostgradient/interborough-plugin';
import { MemoryStorage } from '@lostgradient/storage';
import { createAgent, createSubagentTool, type RunnableAgent } from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import { createAgentContributions } from './agent-contributions';
import { createBureau } from './create-bureau';
import { runTask } from './test';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import { listedPlugins } from './testing/plugin-listing.test-support';
import type { BureauPluginSecrets } from './plugins/plugin-types';
import type { Bureau } from './types';

/** An every-agent set whose `onStep` records the content of each step it sees. */
function stepAudit(seen: string[]): PluginInterceptor {
  return {
    name: 'step-audit',
    appliesTo: 'every-agent',
    onStep: {
      handler: async (step) => {
        seen.push(step.content);
      },
      replay: 'safe',
    },
  };
}

const harnesses: FileBureauHarness[] = [];
const bureaus: Bureau<AgentDefinitions>[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

/**
 * A Bureau over an agent directory holding `helper.md`, whose model calls `lookup-order` on its
 * first step and answers `helper-done` on its second, beside the code agent `alpha`.
 */
async function fileBureau(
  seen: string[],
  frontmatter: Record<string, string> = {},
): Promise<FileBureauHarness> {
  let calls = 0;
  const harness = await startFileBureau({
    scripts: {
      'claude-opus-5-5': () =>
        calls++ === 0
          ? { content: '', toolCalls: [{ name: 'lookup-order', arguments: {} }] }
          : 'helper-done',
    },
    overrides: {
      agentContributions: createAgentContributions([
        { plugin: 'audit', interceptors: [stepAudit(seen)] },
      ]),
    },
  });
  harnesses.push(harness);
  await harness.put(
    'helper.md',
    agentFileText({ model: KNOWN_MODEL, tools: '[lookup-order]', ...frontmatter }),
  );
  await harness.bureau.agents.refresh();
  return harness;
}

describe('an every-agent interceptor (COR-2127)', () => {
  it('fires once per step for a file agent that does not list it', async () => {
    const seen: string[] = [];
    const harness = await fileBureau(seen);

    const result = await runTask(harness.bureau, 'helper', 'Find my order');

    expect(result.content).toBe('helper-done');
    await waitUntil(() => seen.includes('helper-done'), { message: 'the second step’s onStep' });
    expect(seen).toEqual(['', 'helper-done']);
  });

  it('registers once for a file agent that also lists it', async () => {
    const seen: string[] = [];
    const harness = await fileBureau(seen, { interceptors: '[audit:step-audit]' });

    const result = await runTask(harness.bureau, 'helper', 'Find my order');

    expect(result.content).toBe('helper-done');
    await waitUntil(() => seen.includes('helper-done'), { message: 'the second step’s onStep' });
    expect(seen).toEqual(['', 'helper-done']);
  });

  it('fires for a code agent', async () => {
    const seen: string[] = [];
    const harness = await fileBureau(seen);

    const result = await runTask(harness.bureau, 'alpha', 'Hello');

    expect(result.content).toBe('alpha');
    await waitUntil(() => seen.length > 0, { message: 'the code agent’s onStep' });
    expect(seen).toEqual(['alpha']);
  });

  it('fires for a catalog dispatch', async () => {
    const seen: string[] = [];
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        parent: createAgent({ generate: () => new Promise<never>(() => {}) }),
        worker: createAgent({
          name: 'worker',
          generate: async () => ({ content: 'worker-done', toolCalls: [] }),
        }),
      },
      agentContributions: createAgentContributions([
        { plugin: 'audit', interceptors: [stepAudit(seen)] },
      ]),
      storage: new MemoryStorage(),
    });
    bureaus.push(bureau);
    const parent = await bureau.tasks.start('parent', 'plan the work');

    const started = await bureau.children.dispatch({
      parentRunId: parent.id,
      agentName: 'worker',
      input: 'work',
      childRunId: 'audited-child',
    });
    expect(started).toMatchObject({ outcome: 'started' });
    expect(
      await bureau.children.wait({ parentRunId: parent.id, childRunId: 'audited-child' }),
    ).toMatchObject({ outcome: 'settled', child: { status: 'completed' } });

    await waitUntil(() => seen.length > 0, { message: 'the dispatched child’s onStep' });
    expect(seen).toEqual(['worker-done']);
  });

  it('fires for a child a Bureau-owned run dispatches through a subagent tool', async () => {
    const seen: string[] = [];
    const researcher = createAgent({
      name: 'researcher',
      generate: async () => ({ content: 'researcher-done', toolCalls: [] }),
    });
    const delegate = createSubagentTool({
      name: 'delegate',
      description: 'Delegate',
      agent: researcher,
      agentName: 'researcher',
      input: z.object({ q: z.string() }),
    });
    let step = 0;
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        supervisor: createAgent({
          name: 'supervisor',
          toolbox: createToolbox([delegate]),
          generate: async () =>
            step++ === 0
              ? { content: '', toolCalls: [{ id: 'c1', name: 'delegate', arguments: { q: 'hi' } }] }
              : { content: 'supervisor-done', toolCalls: [] },
        }),
      },
      agentContributions: createAgentContributions([
        { plugin: 'audit', interceptors: [stepAudit(seen)] },
      ]),
      storage: new MemoryStorage(),
    });
    bureaus.push(bureau);

    const result = await runTask(bureau, 'supervisor', 'go');

    expect(result.content).toBe('supervisor-done');
    await waitUntil(() => seen.includes('supervisor-done'), { message: 'the supervisor’s onStep' });
    // The child's step and both of the supervisor's, each once.
    expect(seen.toSorted()).toEqual(['', 'researcher-done', 'supervisor-done']);
  });
});

describe('an every-agent interceptor whose plugin needs setup (COR-2127)', () => {
  const KEY = 'audit-api-key';

  /** A secrets reader the test saves to, notifying watchers as a host would. */
  function secretsStore() {
    const values = new Map<string, string>();
    const watchers = new Map<string, Set<() => void>>();
    const reader: BureauPluginSecrets & { save(key: string, value: string): void } = {
      get: async (key) => values.get(key),
      watch(key, listener) {
        const set = watchers.get(key) ?? new Set();
        set.add(listener);
        watchers.set(key, set);
        return () => set.delete(listener);
      },
      save(key, value) {
        values.set(key, value);
        for (const listener of watchers.get(key) ?? []) listener();
      },
    };
    return reader;
  }

  it('is skipped, so another agent’s steps succeed, and runs once the secret is saved', async () => {
    const seen: string[] = [];
    const secrets = secretsStore();
    const audit = definePlugin({
      name: 'audit',
      version: '1.0.0',
      description: 'Audits every step.',
      secrets: [KEY],
      setup: () => ({ interceptors: [stepAudit(seen)] }),
    });
    const alpha: RunnableAgent = createAgent({
      name: 'alpha',
      generate: async () => ({ content: 'alpha-done', toolCalls: [] }),
    });
    const bureau = await createBureau<AgentDefinitions>({
      agents: { alpha },
      plugins: [{ descriptor: audit, source: 'package', location: '@example/audit' }],
      pluginSecrets: secrets,
      storage: new MemoryStorage(),
    });
    bureaus.push(bureau);
    const [listing] = await listedPlugins(bureau);
    expect(listing?.status).toBe('needs-setup');

    const skipped = await runTask(bureau, 'alpha', 'Hello');

    expect(skipped.finishReason).not.toBe('error');
    expect(skipped.content).toBe('alpha-done');
    expect(seen).toEqual([]);

    secrets.save(KEY, 'sk-audit-0123456789');
    await waitUntil(
      async () => {
        const [current] = await listedPlugins(bureau);
        return current?.status === 'running';
      },
      { message: 'the plugin to run once its secret is saved' },
    );
    const ran = await runTask(bureau, 'alpha', 'Hello again');

    expect(ran.content).toBe('alpha-done');
    await waitUntil(() => seen.length > 0, { message: 'the set’s onStep once it can run' });
    expect(seen).toEqual(['alpha-done']);
  });
  // Ruling on decision 4 (2026-11-09): an agent that lists an every-agent set chose it, so it keeps
  // H1's refusal; every other agent skips it.
  it('refuses the step of an agent that lists it, while one that does not succeeds and skips it', async () => {
    const seen: string[] = [];
    const audit = definePlugin({
      name: 'audit',
      version: '1.0.0',
      description: 'Audits every step.',
      secrets: [KEY],
      setup: () => ({ interceptors: [stepAudit(seen)] }),
    });
    const harness = await startFileBureau({
      scripts: { 'claude-opus-5-5': () => 'helper-done' },
      overrides: {
        plugins: [{ descriptor: audit, source: 'package', location: '@example/audit' }],
        pluginSecrets: secretsStore(),
      },
    });
    harnesses.push(harness);
    await harness.put(
      'helper.md',
      agentFileText({ model: KNOWN_MODEL, interceptors: '[audit:step-audit]' }),
    );
    await harness.bureau.agents.refresh();
    const [listing] = await listedPlugins(harness.bureau);
    expect(listing?.status).toBe('needs-setup');

    const listed = await runTask(harness.bureau, 'helper', 'Hello');
    const unlisted = await runTask(harness.bureau, 'alpha', 'Hello');

    expect(listed.finishReason).toBe('error');
    expect(unlisted.finishReason).not.toBe('error');
    expect(unlisted.content).toBe('alpha');
    expect(seen).toEqual([]);
  });
});
