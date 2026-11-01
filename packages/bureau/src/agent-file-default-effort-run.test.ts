/**
 * COR-1961 — a run of a file agent with a `defaultEffort` on a Bureau: a step on a model that
 * cannot do the tier is judged by the run owner's `effortFallbackMode` from the live `modelPolicy`
 * (`reject` when it names none), the failure ends the run with the typed error, and the default
 * never reaches the session's steering.
 */
import type { GenerateFunction } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import type { BureauModelPolicyOptions } from './model-policy';
import { OWNER } from './http/management/management-fixtures.test-support';
import { waitForTaskState } from './test';
import { startTaskFrom } from './test/task-start-request.ts';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';

const harnesses: FileBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

/** Takes low, medium and high; `max` lowers to `high`. */
const THREE_TIERS = 'anthropic/claude-opus-4-5';
/** Takes no effort at all. */
const NO_EFFORT = 'openai/gpt-4.1';

const PICKER = agentFileText({
  model: KNOWN_MODEL,
  models: `[${KNOWN_MODEL}, ${THREE_TIERS}, ${NO_EFFORT}]`,
  defaultEffort: 'max',
});

interface Sighting {
  readonly model: string | undefined;
  readonly effort: string | undefined;
}

async function start(modelPolicy?: BureauModelPolicyOptions) {
  const seen: Sighting[] = [];
  const generate: GenerateFunction = async (context) => {
    seen.push({ model: context.steering?.model, effort: context.steering?.effort });
    return { content: 'done', toolCalls: [] };
  };
  const harness = await startFileBureau({
    overrides: {
      id: 'default-effort-run-bureau',
      models: { generate: () => generate },
      ...(modelPolicy === undefined ? {} : { modelPolicy }),
    },
  });
  harnesses.push(harness);
  await harness.put('picker.md', PICKER);
  await harness.bureau.agents.refresh();
  return { harness, seen };
}

async function run(harness: FileBureauHarness, contextId?: string) {
  const started = await startTaskFrom(harness.bureau, {
    input: 'go',
    agentName: 'picker',
    principal: OWNER.alice,
    ...(contextId === undefined ? {} : { contextId }),
  });
  await waitForTaskState(harness.bureau, started.id);
  return started;
}

async function switchTo(harness: FileBureauHarness, contextId: string, id: string, model: string) {
  const [provider, name] = model.split('/');
  const steered = await harness.bureau.contexts.steer(contextId, {
    id,
    principal: OWNER.alice,
    requestedValue: { target: 'model', override: name, provider } as never,
  });
  expect(steered.outcome).toBe('accepted');
}

const DEGRADE: BureauModelPolicyOptions = {
  users: { [OWNER.alice]: { effortFallbackMode: 'degrade' } },
  policyRevision: 2,
};

describe('a run whose default effort the model takes', () => {
  it('sends it, and writes nothing to the chat’s steering', async () => {
    const { harness, seen } = await start();
    const first = await run(harness);

    expect(seen).toEqual([{ model: undefined, effort: 'max' }]);
    // The chat's desired state is still at version 0: a command that expects it is accepted.
    const steered = await harness.bureau.contexts.steer(first.contextId, {
      id: 'first-command',
      principal: OWNER.alice,
      expectedRevision: 0,
      requestedValue: { target: 'effort', override: 'low' },
    });
    expect(steered.outcome).toBe('accepted');
  });
});

describe('a run on a model that cannot do the default effort', () => {
  it('ends in error naming the model under the default mode, and calls no provider', async () => {
    const { harness, seen } = await start();
    const first = await run(harness);
    await switchTo(harness, first.contextId, 'to-three', THREE_TIERS);
    seen.length = 0;

    const second = await run(harness, first.contextId);

    const summary = harness.bureau.tasks.detail(second.id);
    expect(summary?.status).toBe('error');
    expect(summary?.error).toContain(THREE_TIERS);
    expect(summary?.error).toContain('EffortNotSupportedError');
    expect(summary?.error).toContain('default effort');
    expect(seen).toEqual([]);
  });

  it('lowers the tier under a degrade profile, read live at the step', async () => {
    const { harness, seen } = await start();
    const first = await run(harness);
    await switchTo(harness, first.contextId, 'to-three', THREE_TIERS);
    const { revision } = await harness.bureau.settings.get();
    const applied = await harness.bureau.settings.update(
      { modelPolicy: DEGRADE },
      { expectedRevision: revision },
    );
    expect(applied.outcome).toBe('applied');
    seen.length = 0;

    await run(harness, first.contextId);

    expect(seen).toEqual([{ model: 'claude-opus-4-5', effort: 'high' }]);
  });

  it('sends no effort under a degrade profile when the model supports none', async () => {
    const { harness, seen } = await start(DEGRADE);
    const first = await run(harness);
    await switchTo(harness, first.contextId, 'to-none', NO_EFFORT);
    seen.length = 0;

    await run(harness, first.contextId);

    expect(seen).toEqual([{ model: 'gpt-4.1', effort: undefined }]);
  });

  it('rejects for a run owned by a principal whose profile says nothing', async () => {
    const { harness, seen } = await start({
      users: { [OWNER.bob]: { effortFallbackMode: 'degrade' } },
      policyRevision: 2,
    });
    const first = await run(harness);
    await switchTo(harness, first.contextId, 'to-three', THREE_TIERS);
    seen.length = 0;

    const second = await run(harness, first.contextId);

    expect(harness.bureau.tasks.detail(second.id)?.status).toBe('error');
    expect(seen).toEqual([]);
  });

  it('uses the effort the person steered instead of refusing', async () => {
    const { harness, seen } = await start();
    const first = await run(harness);
    await switchTo(harness, first.contextId, 'to-none', NO_EFFORT);
    const steered = await harness.bureau.contexts.steer(first.contextId, {
      id: 'effort',
      principal: OWNER.alice,
      requestedValue: { target: 'effort', override: 'low' },
    });
    expect(steered.outcome).toBe('accepted');
    seen.length = 0;

    const second = await run(harness, first.contextId);

    expect(harness.bureau.tasks.detail(second.id)?.status).toBe('completed');
    expect(seen).toEqual([{ model: 'gpt-4.1', effort: 'low' }]);
  });
});
