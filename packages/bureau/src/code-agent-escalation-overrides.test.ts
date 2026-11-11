/**
 * COR-2386 — a built-in agent's `escalations` override names plugin guardrails by id, as an agent
 * file's `escalations` does (COR-2109): the value round-trips through the overrides wire, a save
 * that lists an id twice or one no plugin contributes writes nothing, and the override tracker runs
 * the escalated guardrails only once the session is tainted.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import type { PluginInputGuardrail } from '@lostgradient/interborough-plugin';
import { createAgent, type InputDetector } from '@lostgradient/operative';

import { createAgentContributions } from './agent-contributions';
import { AgentFileError } from './agent-file';
import type { AgentOverrides } from './agent-override-store';
import {
  agentOverridesInputSchema,
  agentOverridesOutputSchema,
  overridesOf,
  overridesView,
} from './http/management/agent-overrides-wire';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';

const TAINTING = 'TAINT-NOW';
const SENTINEL = 'SENTINEL';

/** Taints the session on its marker, as the code agent's own guardrail does. */
const tainting: InputDetector = {
  name: 'tainting',
  detect: async (input) => ({
    triggered: input.includes(TAINTING),
    confidence: 0.95,
    category: 'prompt-injection',
  }),
};

/** The escalation: trips on the sentinel, and so only where it runs. */
const sentinel: PluginInputGuardrail = {
  name: 'sentinel',
  description: 'Trips on the sentinel.',
  detect: async (input) => ({
    triggered: input.includes(SENTINEL),
    confidence: 1,
    category: 'sentinel',
  }),
};

const contributions = createAgentContributions([
  { plugin: 'x', guardrails: { input: [sentinel] } },
]);

const harnesses: FileBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
});

async function start(): Promise<FileBureauHarness> {
  const harness = await startFileBureau({
    agents: {
      replier: createAgent({
        name: 'replier',
        guardrails: { input: { detectors: [tainting], action: 'warn' } },
        generate: async () => ({ content: 'ok', toolCalls: [] }),
      }),
    },
    overrides: { agentContributions: contributions },
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

async function ask(harness: FileBureauHarness, message: string, contextId?: string) {
  const task = await harness.bureau.tasks.start('replier', message, {
    principal: 'api-key:alice',
    ...(contextId === undefined ? {} : { contextId }),
  });
  const result = await task.result();
  return { contextId: task.contextId, finishReason: result.finishReason };
}

describe('a built-in agent’s escalations override (COR-2386)', () => {
  it('round-trips through the overrides wire and the store', async () => {
    const wire = agentOverridesInputSchema.parse({ escalations: ['x:sentinel'] });
    const overrides = overridesOf(wire);
    expect(overrides).toEqual({ escalations: ['x:sentinel'] });
    expect(agentOverridesOutputSchema.parse(overridesView(overrides)).escalations).toEqual([
      'x:sentinel',
    ]);
    expect(overridesView({}).escalations).toBeNull();

    const harness = await start();
    await save(harness, overrides);
    const stored = await harness.bureau.agents.overrides.get('replier');
    expect(stored?.overrides).toEqual({ escalations: ['x:sentinel'] });
    expect(overridesView(stored!.overrides).escalations).toEqual(['x:sentinel']);
  });

  it('refuses an escalation listed twice, or one nothing contributes, and writes nothing', async () => {
    const harness = await start();
    const before = await harness.bureau.agents.overrides.get('replier');

    const repeated = await refusalOf(harness, { escalations: ['x:sentinel', 'x:sentinel'] });
    expect(repeated.code).toBe('invalid-frontmatter');
    expect(repeated.problem?.issues?.[0]?.path).toBe('escalations.1');

    const unknown = await refusalOf(harness, { escalations: ['y:gone'] });
    expect(unknown.code).toBe('reference-unresolved');
    expect(unknown.problem?.issues?.[0]?.path).toBe('escalations.0');

    expect(await harness.bureau.agents.overrides.get('replier')).toEqual(before);
  });

  it('runs the escalation only once the session is tainted', async () => {
    const harness = await start();
    await save(harness, { escalations: ['x:sentinel'] });

    // An untainted session is not judged by it.
    const untainted = await ask(harness, SENTINEL);
    expect(untainted.finishReason).not.toBe('tripwire');

    // The agent's own guardrail taints a session; its next turn is then judged by the escalation.
    const first = await ask(harness, TAINTING);
    const second = await ask(harness, SENTINEL, first.contextId);
    expect(second.finishReason).toBe('tripwire');
  });
});
