/**
 * COR-1980 — the model policy binds a file agent's run, not only the write that saved it. A run
 * whose model the deployment or the Bureau forbids ends in error naming the model before any
 * provider is called, whether the file was saved before the policy tightened or the policy
 * tightened while the Bureau ran. A steer to a forbidden model is refused `policy-denied`; one
 * admitted before the policy tightened fails at its next step.
 */
import { EventType } from '@ag-ui/core';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureauHandler } from './http/create-bureau-handler';
import { runAgentInput, startRequest } from './http/ag-ui-fixtures.test-support';
import { readAgUiStream } from './http/ag-ui-stream.test-support';
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

const OPUS_5 = { provider: 'anthropic', model: 'claude-opus-5' } as const;

const DENY_DEFAULT: BureauModelPolicyOptions = {
  deployment: { deniedModels: ['claude-opus-5-5'] },
  policyRevision: 2,
};
const DENY_OPUS_5: BureauModelPolicyOptions = {
  bureau: { deniedModels: ['claude-opus-5'] },
  policyRevision: 2,
};
const ALLOW_ALL: BureauModelPolicyOptions = { policyRevision: 3 };

const PICKER = agentFileText({
  model: KNOWN_MODEL,
  models: `[${KNOWN_MODEL}, anthropic/claude-opus-5]`,
});

async function start(modelPolicy?: BureauModelPolicyOptions) {
  const calls: string[] = [];
  const harness = await startFileBureau({
    scripts: {
      'claude-opus-5-5': () => (calls.push('claude-opus-5-5'), 'done'),
      'claude-opus-5': () => (calls.push('claude-opus-5'), 'done'),
    },
    overrides: {
      id: 'model-policy-run-bureau',
      ...(modelPolicy === undefined ? {} : { modelPolicy }),
    },
  });
  harnesses.push(harness);
  await harness.put('picker.md', PICKER);
  await harness.bureau.agents.refresh();
  return { harness, calls };
}

async function runPicker(harness: FileBureauHarness, contextId?: string) {
  const run = await startTaskFrom(harness.bureau, {
    input: 'go',
    agentName: 'picker',
    principal: OWNER.alice,
    ...(contextId === undefined ? {} : { contextId }),
  });
  await waitForTaskState(harness.bureau, run.id);
  return run;
}

async function setPolicy(harness: FileBureauHarness, modelPolicy: BureauModelPolicyOptions) {
  const { revision } = await harness.bureau.settings.get();
  const applied = await harness.bureau.settings.update(
    { modelPolicy },
    { expectedRevision: revision },
  );
  expect(applied.outcome).toBe('applied');
}

const steer = (harness: FileBureauHarness, contextId: string, id: string, model: string) =>
  harness.bureau.contexts.steer(contextId, {
    id,
    principal: OWNER.alice,
    requestedValue: { target: 'model', override: model, provider: 'anthropic' } as never,
  });

describe('a run of a file agent whose default model the policy forbids', () => {
  it('ends in error naming the model, and never calls the provider', async () => {
    const { harness, calls } = await start(DENY_DEFAULT);

    const run = await runPicker(harness);

    const summary = harness.bureau.tasks.detail(run.id);
    expect(summary?.status).toBe('error');
    expect(summary?.error).toContain('anthropic/claude-opus-5-5');
    expect(summary?.error).toContain('deployment');
    expect(calls).toEqual([]);
    expect(harness.observed).toEqual([]);
  });

  it('reaches an AG-UI client as a RUN_ERROR that names the model', async () => {
    const { harness, calls } = await start(DENY_DEFAULT);
    const handler = createBureauHandler(harness.bureau, {
      unauthenticatedAccess: 'allow',
      agUi: {},
    });

    const response = await handler(
      startRequest(runAgentInput({ threadId: 'policy-thread', runId: 'policy-run' }), {}, 'picker'),
    );
    const frames = await readAgUiStream(response);
    const events = frames.map((frame) => frame.event);

    const failure = events.find((event) => event.type === EventType.RUN_ERROR);
    expect(failure).toMatchObject({
      message: expect.stringContaining('anthropic/claude-opus-5-5'),
    });
    expect(calls).toEqual([]);
  });

  it('still lists the file ready, because only a write and a run ask the policy', async () => {
    const { harness } = await start(DENY_DEFAULT);

    expect(harness.bureau.agents.list().find((listing) => listing.id === 'picker')).toMatchObject({
      state: 'ready',
    });
  });

  it('fails the next run when the policy tightens after a run succeeded, and recovers when it loosens', async () => {
    const { harness, calls } = await start();
    const before = await runPicker(harness);
    await setPolicy(harness, DENY_DEFAULT);

    const during = await runPicker(harness);
    await setPolicy(harness, ALLOW_ALL);
    const after = await runPicker(harness);

    expect(harness.bureau.tasks.detail(before.id)?.status).not.toBe('error');
    expect(harness.bureau.tasks.detail(during.id)?.status).toBe('error');
    expect(harness.bureau.tasks.detail(during.id)?.error).toContain('claude-opus-5-5');
    expect(harness.bureau.tasks.detail(after.id)?.status).not.toBe('error');
    expect(calls).toEqual(['claude-opus-5-5', 'claude-opus-5-5']);
  });
});

describe('a policy that tightens while a run is in flight', () => {
  it('lets the provider call in flight finish and fails the run at its next step', async () => {
    const calls: string[] = [];
    let tighten: () => Promise<void> = async () => {};
    const harness = await startFileBureau({
      scripts: {
        'claude-opus-5-5': async () => {
          calls.push('claude-opus-5-5');
          if (calls.length === 1) await tighten();
          return { content: 'looking', toolCalls: [{ name: 'lookup-order', arguments: {} }] };
        },
      },
      overrides: { id: 'model-policy-in-flight-bureau' },
    });
    harnesses.push(harness);
    await harness.put('looper.md', agentFileText({ model: KNOWN_MODEL, tools: '[lookup-order]' }));
    await harness.bureau.agents.refresh();
    tighten = () => setPolicy(harness, DENY_DEFAULT);

    const run = await startTaskFrom(harness.bureau, {
      input: 'go',
      agentName: 'looper',
      principal: OWNER.alice,
    });
    await waitForTaskState(harness.bureau, run.id);

    const summary = harness.bureau.tasks.detail(run.id);
    expect(calls).toEqual(['claude-opus-5-5']);
    expect(summary?.status).toBe('error');
    expect(summary?.error).toContain('anthropic/claude-opus-5-5');
  });
});

describe('a steer to a model the policy forbids', () => {
  it('is refused policy-denied and changes nothing, while an allowed model is admitted', async () => {
    const { harness } = await start(DENY_OPUS_5);
    const first = await runPicker(harness);

    const refused = await steer(harness, first.contextId, 'to-opus-5', 'claude-opus-5');
    const steeringAfterRefusal = await harness.bureau.contexts.steering(first.contextId);
    const admitted = await steer(harness, first.contextId, 'to-default', 'claude-opus-5-5');

    expect(refused).toMatchObject({ outcome: 'rejected', failure: { reason: 'policy-denied' } });
    expect(steeringAfterRefusal).toMatchObject({ model: null });
    expect(admitted.outcome).toBe('accepted');
  });

  it('is admitted before the policy tightens, and then fails at the next step naming the model', async () => {
    const { harness, calls } = await start();
    const first = await runPicker(harness);
    const admitted = await steer(harness, first.contextId, 'to-opus-5', 'claude-opus-5');
    expect(admitted.outcome).toBe('accepted');
    await setPolicy(harness, DENY_OPUS_5);

    const second = await runPicker(harness, first.contextId);

    const summary = harness.bureau.tasks.detail(second.id);
    expect(summary?.status).toBe('error');
    expect(summary?.error).toContain('anthropic/claude-opus-5');
    expect(summary?.error).toContain('bureau');
    expect(calls).toEqual(['claude-opus-5-5']);
  });

  it('is answered as rejected when a fork carries it after the policy tightened', async () => {
    const { harness } = await start();
    const first = await runPicker(harness);
    const admitted = await steer(harness, first.contextId, 'to-opus-5', OPUS_5.model);
    expect(admitted.outcome).toBe('accepted');
    await setPolicy(harness, DENY_OPUS_5);

    const forked = await harness.bureau.contexts.fork(first.contextId, {
      owner: OWNER.alice,
      commandId: 'fork-1',
      throughMessageId: null,
    });

    expect(forked.carriedOverride).toMatchObject({
      outcome: 'rejected',
      failure: { reason: 'policy-denied' },
    });
    expect(await harness.bureau.contexts.steering(forked.contextId)).toMatchObject({ model: null });
  });
});
