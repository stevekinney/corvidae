/**
 * COR-2118 — a built-in agent's `guardrails` override takes the same entries an agent file does: a
 * configured guardrail judges its runs with that configuration, a save that lists an id twice or
 * configures a guardrail in a way its schema refuses writes nothing and names the id or the field,
 * and a record stored with ids alone, or with an id repeated, still reads and applies.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import type { PluginGuardrailFactory } from '@lostgradient/interborough-plugin';
import { createAgent, type OutputValidator } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { z } from 'zod';

import { createAgentContributions } from './agent-contributions';
import { AgentFileError } from './agent-file';
import { type AgentOverrides, agentOverrideVersionKey } from './agent-override-store';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import { runTask } from './test';

const REPLY = 'x'.repeat(15);

const limitFactory: PluginGuardrailFactory<OutputValidator, { readonly maximum: number }> = {
  name: 'limit',
  description: 'Flags a reply longer than its maximum.',
  configuration: z.strictObject({ maximum: z.number().int().min(1).default(20) }),
  create: ({ maximum }) => ({
    name: 'limit',
    validate: async (output) => ({
      valid: output.length <= maximum,
      category: 'long',
      confidence: 1,
    }),
  }),
};

const contributions = createAgentContributions([
  { plugin: 'x', guardrails: { output: [limitFactory] } },
]);

const harnesses: FileBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
});

async function start(storage = new MemoryStorage()): Promise<FileBureauHarness> {
  const harness = await startFileBureau({
    agents: {
      replier: createAgent({
        name: 'replier',
        guardrails: false,
        generate: async () => ({ content: REPLY, toolCalls: [] }),
      }),
    },
    overrides: { storage, agentContributions: contributions },
  });
  harnesses.push(harness);
  return harness;
}

async function save(harness: FileBureauHarness, overrides: AgentOverrides) {
  const { hash } = (await harness.bureau.agents.overrides.get('replier'))!;
  return harness.bureau.agents.overrides.save('replier', overrides, { expectedHash: hash });
}

async function refusalOf(harness: FileBureauHarness, overrides: AgentOverrides) {
  const error = await save(harness, overrides).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(AgentFileError);
  return error as AgentFileError;
}

describe('a built-in agent’s guardrails override', () => {
  it('runs a configured guardrail with its configuration', async () => {
    const harness = await start();

    await save(harness, { guardrails: [{ id: 'x:limit', configuration: { maximum: 30 } }] });
    const lenient = await runTask(harness.bureau, 'replier', 'Hi');
    expect(lenient.finishReason).not.toBe('tripwire');

    await save(harness, { guardrails: [{ id: 'x:limit', configuration: { maximum: 10 } }] });
    const strict = await runTask(harness.bureau, 'replier', 'Hi');
    expect(strict.finishReason).toBe('tripwire');
  });

  it('refuses a configuration the schema refuses, naming the field, and writes nothing', async () => {
    const harness = await start();
    const before = await harness.bureau.agents.overrides.get('replier');

    const error = await refusalOf(harness, {
      guardrails: [{ id: 'x:limit', configuration: { maximum: 0 } }],
    });

    expect(error.code).toBe('invalid-guardrail-configuration');
    expect(error.problem?.issues).toEqual([
      {
        path: 'guardrails.0.configuration.maximum',
        message: expect.stringContaining('"x:limit" refuses `maximum`'),
        reference: 'x:limit',
      },
    ]);
    expect(await harness.bureau.agents.overrides.get('replier')).toEqual(before);
  });

  it('refuses a guardrail listed twice, naming the id', async () => {
    const harness = await start();

    const error = await refusalOf(harness, { guardrails: ['x:limit', 'x:limit'] });

    expect(error.code).toBe('invalid-frontmatter');
    expect(error.problem?.issues).toEqual([
      {
        path: 'guardrails.1',
        message: '"x:limit" is listed more than once; list each guardrail once',
      },
    ]);
  });

  it('reads and applies a record stored with ids alone, one of them repeated', async () => {
    const storage = new MemoryStorage();
    await textValueStore(storage).set(
      agentOverrideVersionKey('replier', 1),
      JSON.stringify({
        version: 1,
        hash: 'e'.repeat(64),
        savedAt: '2026-10-01T00:00:00.000Z',
        savedBy: 'anonymous:local',
        owner: 'anonymous:local',
        overrides: { guardrails: ['x:limit', 'x:limit'] },
        changedKeys: ['guardrails'],
      }),
    );
    const harness = await start(storage);

    const stored = await harness.bureau.agents.overrides.get('replier');
    expect(stored?.overrides).toEqual({ guardrails: ['x:limit', 'x:limit'] });
    // The default maximum, 20, lets the 15-character reply through: the guardrail ran once.
    const result = await runTask(harness.bureau, 'replier', 'Hi');
    expect(result.finishReason).not.toBe('tripwire');
  });
});
