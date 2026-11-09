/**
 * COR-2009 — the overrides saved on a built-in agent change its runs: the newest version is the
 * overrides in force, so a Blocked tool refuses, a tool taken off the list is not offered, a model
 * override answers, a restore puts the earlier settings back, and an agent nobody changed runs
 * exactly as it is defined. The persisted override records are the store's, unchanged.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import type { AgentOverrides } from './agent-override-store';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import { KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { runTask } from './test';

/** The built-in agent's own tools; a run's toolbox also holds the tools Bureau adds to every run. */
const OWN_TOOLS = new Set(['lookup-order', 'issue-refund']);
/** The tools that ran, by name, in the order they ran. */
const executed: string[] = [];
/** What the built-in agent's own model was shown at each step. */
const seen: { readonly tools: readonly string[]; readonly system: string | undefined }[] = [];

const orderTool = (name: string, metadata: { readOnly: true } | { mutates: true }) =>
  createTool({
    name,
    version: '1.0.0',
    description: name,
    input: z.object({}),
    metadata,
    execute: async () => {
      executed.push(name);
      return { ok: name };
    },
  });

/**
 * The built-in agent's own model: it asks to refund the order once, then reports what the tool
 * answered, so a run's content says whether the refund ran, was refused, or was not there at all.
 */
const ownGenerate: GenerateFunction = async ({ conversation, toolbox }) => {
  const system = conversation.getFirstSystemMessage()?.content;
  seen.push({
    tools: toolbox
      .tools()
      .map((tool) => tool.name)
      .filter((name) => OWN_TOOLS.has(name))
      .toSorted(),
    system: typeof system === 'string' ? system : undefined,
  });
  const result = conversation.getMessages().findLast((message) => message.toolResult)?.toolResult;
  if (result !== undefined) return { content: JSON.stringify(result), toolCalls: [] };
  return { content: '', toolCalls: [{ name: 'issue-refund', arguments: {} }] };
};

const refunder = () =>
  createAgent({
    name: 'refunder',
    instructions: 'You refund orders.',
    generate: ownGenerate,
    toolbox: createToolbox([
      orderTool('lookup-order', { readOnly: true }),
      orderTool('issue-refund', { mutates: true }),
    ]),
    stopWhen: [stopWhen.pendingApproval(), stopWhen.noToolCalls()],
  });

const harnesses: FileBureauHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
  executed.length = 0;
  seen.length = 0;
});

async function start(
  agents: AgentDefinitions = { refunder: refunder() },
  storage = new MemoryStorage(),
): Promise<FileBureauHarness> {
  const harness = await startFileBureau({ agents, overrides: { storage } });
  harnesses.push(harness);
  return harness;
}

async function save(harness: FileBureauHarness, overrides: AgentOverrides) {
  const { hash } = (await harness.bureau.agents.overrides.get('refunder'))!;
  return harness.bureau.agents.overrides.save('refunder', overrides, { expectedHash: hash });
}

describe('a built-in agent with saved overrides', () => {
  it('runs as it is defined when nobody changed it', async () => {
    const agents = { refunder: refunder() };
    const harness = await start(agents);

    expect(harness.bureau.agents.find('refunder')).toBe(agents.refunder);
    const result = await runTask(harness.bureau, 'refunder', 'Refund order 4471.');

    expect(executed).toEqual(['issue-refund']);
    expect(result.content).toContain('"ok":"issue-refund"');
    expect(seen[0]).toEqual({
      tools: ['issue-refund', 'lookup-order'],
      system: 'You refund orders.',
    });
  });

  it('refuses a tool the overrides set to Blocked', async () => {
    const harness = await start();
    await save(harness, { approvals: { 'issue-refund': 'blocked' } });

    const result = await runTask(harness.bureau, 'refunder', 'Refund order 4471.');

    expect(executed).toEqual([]);
    expect(result.content).not.toContain('"ok":"issue-refund"');
    expect(JSON.parse(result.content)).toMatchObject({
      outcome: 'error',
      error: { code: 'POLICY_DENIED', category: 'permission' },
    });
    // A run started on the agent itself, outside any Bureau run path, is refused the same way.
    const direct = await harness.bureau.agents.find('refunder')!.run('Refund order 4471.').result();
    expect(executed).toEqual([]);
    expect(JSON.parse(direct.content)).toMatchObject({ error: { code: 'POLICY_DENIED' } });
  });

  it('does not offer a tool the overrides took off its list, and refuses a call to it', async () => {
    const harness = await start();
    await save(harness, { tools: ['lookup-order'] });

    const result = await runTask(harness.bureau, 'refunder', 'Refund order 4471.');

    expect(seen[0]?.tools).toEqual(['lookup-order']);
    expect(executed).toEqual([]);
    expect(JSON.parse(result.content)).toMatchObject({ outcome: 'error' });
  });

  it('starts from the overridden instructions and stops at the overridden step limit', async () => {
    const harness = await start();
    await save(harness, { instructions: 'You only look orders up.', stepLimit: 1 });

    const result = await runTask(harness.bureau, 'refunder', 'Refund order 4471.');

    expect(seen.map((step) => step.system)).toEqual(['You only look orders up.']);
    expect(result.finishReason).toBe('maximum-steps');
  });

  it('answers from the overridden model, and shows it as the agent’s model', async () => {
    const harness = await start();
    await save(harness, { model: KNOWN_MODEL });

    const result = await runTask(harness.bureau, 'refunder', 'Refund order 4471.');

    expect(result.content).toBe('claude-opus-5-5');
    expect(harness.observed.map((observation) => observation.model)).toEqual(['claude-opus-5-5']);
    expect(seen).toEqual([]);
    const detail = await harness.bureau.agents.detail('refunder');
    expect(detail?.codeDefinition).toMatchObject({
      model: KNOWN_MODEL,
      tools: ['lookup-order', 'issue-refund'],
    });
    expect(harness.bureau.agents.models('refunder')?.default).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
    });
  });

  it('puts the earlier settings back in force when an earlier version is restored', async () => {
    const harness = await start();
    await save(harness, { tools: ['lookup-order'] });
    const second = await save(harness, { tools: ['lookup-order'], model: KNOWN_MODEL });

    await harness.bureau.agents.overrides.restore('refunder', 1, { expectedHash: second.hash });
    const result = await runTask(harness.bureau, 'refunder', 'Refund order 4471.');

    expect(harness.observed).toEqual([]);
    expect(seen[0]?.tools).toEqual(['lookup-order']);
    expect(result.content).not.toBe('claude-opus-5-5');
    const detail = await harness.bureau.agents.detail('refunder');
    expect(detail?.codeDefinition).toMatchObject({ tools: ['lookup-order'] });
  });

  it('reads the overrides in force from the store when the Bureau starts again', async () => {
    const storage = new MemoryStorage();
    const first = await start({ refunder: refunder() }, storage);
    await save(first, { approvals: { 'issue-refund': 'blocked' } });
    await first.dispose();
    harnesses.splice(harnesses.indexOf(first), 1);

    const second = await start({ refunder: refunder() }, storage);
    await runTask(second.bureau, 'refunder', 'Refund order 4471.');

    expect(executed).toEqual([]);
  });
});
