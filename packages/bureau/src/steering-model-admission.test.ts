/**
 * COR-1559 — Bureau admits a `model` steering override only for a model the session's agent
 * allows, decides it when it is admitted rather than at the step boundary, and applies it from
 * the run's next step and to the session's later runs, across a restart.
 */
import { stopWhen, createAgent } from '@lostgradient/operative';
import { createTemporaryPath, removeTemporaryPath } from '@lostgradient/testing/temporary-path';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { waitForRunState } from './test';
import {
  readSteeringLogEntries,
  readSteeringLogHead,
} from './steering-log';
import {
  createSteppedGenerate,
  GPT_4_1,
  noopTool,
  OPUS_5,
  OPUS_5_5,
  twinModelCatalog,
  TWIN_OF_OPUS_5_5,
} from './testing/model-override.test-support';
import type { Bureau } from './types';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** A code-defined agent that names the two Anthropic models it allows. */
function pickerAgent(generate: Parameters<typeof createAgent>[0]['generate']) {
  return createAgent({
    name: 'picker',
    generate,
    tools: { noop: noopTool },
    allowedCandidates: [OPUS_5_5, OPUS_5],
  });
}

async function openBureau(
  options: {
    generate?: Parameters<typeof createAgent>[0]['generate'];
    path?: string;
    durable?: boolean;
    catalog?: ReturnType<typeof twinModelCatalog>;
    allowed?: Parameters<typeof createAgent>[0]['allowedCandidates'];
  } = {},
) {
  const generate =
    options.generate ?? (async () => ({ content: 'ok', toolCalls: [] as never[] }));
  const picker =
    options.allowed === undefined
      ? pickerAgent(generate)
      : createAgent({
          name: 'picker',
          generate,
          tools: { noop: noopTool },
          allowedCandidates: options.allowed,
        });
  const bureau = await createBureau<AgentDefinitions>({
    agents: { picker },
    stopWhen: stopWhen.noToolCalls(),
    storage: options.path === undefined ? { type: 'memory' } : { type: 'sqlite', path: options.path },
    ...(options.durable === false ? {} : { durableExecution: true }),
    ...(options.catalog === undefined ? {} : { modelCatalog: options.catalog }),
  });
  cleanups.push(() => bureau.dispose());
  return bureau;
}

async function startRun(bureau: Bureau<AgentDefinitions>, sessionId?: string) {
  const run = await bureau.createRun({
    message: 'go',
    agentName: 'picker',
    principal: 'alice',
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  return run;
}

const steer = (
  bureau: Pick<Bureau, 'submitSteeringCommand'>,
  sessionId: string,
  id: string,
  override: string,
  provider?: string,
) =>
  bureau.submitSteeringCommand(sessionId, {
    id,
    principal: 'alice',
    requestedValue: {
      target: 'model',
      override,
      ...(provider === undefined ? {} : { provider }),
    } as never,
  });

describe('admission checks the model against the agent', () => {
  it('rejects a catalog model the agent does not allow with model-not-allowed, and a model the catalog lacks with policy-denied', async () => {
    const stepped = createSteppedGenerate();
    const bureau = await openBureau({ generate: stepped.generate });
    const run = await startRun(bureau);
    await stepped.firstStepEntered;

    const outside = await steer(bureau, run.sessionId, 'outside', GPT_4_1.model);
    const unknown = await steer(bureau, run.sessionId, 'unknown', 'no-such-model');

    expect(outside).toEqual({
      outcome: 'rejected',
      failure: { failedAt: expect.any(String), reason: 'model-not-allowed' },
    });
    expect(unknown).toEqual({
      outcome: 'rejected',
      failure: { failedAt: expect.any(String), reason: 'policy-denied' },
    });
    stepped.releaseFirstStep();
  });

  it('admits a model the agent allows and changes desired state only then', async () => {
    const stepped = createSteppedGenerate();
    const bureau = await openBureau({ generate: stepped.generate });
    const run = await startRun(bureau);
    await stepped.firstStepEntered;
    const before = await bureau.getSessionSteering(run.sessionId);

    await steer(bureau, run.sessionId, 'outside', GPT_4_1.model);
    expect(await bureau.getSessionSteering(run.sessionId)).toEqual(before);

    const inside = await steer(bureau, run.sessionId, 'inside', OPUS_5.model, OPUS_5.provider);
    expect(inside.outcome).toBe('accepted');
    expect(await bureau.getSessionSteering(run.sessionId)).toEqual({
      model: { provider: 'anthropic', model: 'claude-opus-5' },
      configVersion: 1,
    });
    stepped.releaseFirstStep();
  });

  it('decides the same way for an in-process bureau with no durable store', async () => {
    const stepped = createSteppedGenerate();
    const bureau = await openBureau({ generate: stepped.generate, durable: false });
    const run = await startRun(bureau);
    await stepped.firstStepEntered;

    const outside = await steer(bureau, run.sessionId, 'outside', GPT_4_1.model);

    expect(outside.outcome === 'rejected' && outside.failure.reason).toBe('model-not-allowed');
    stepped.releaseFirstStep();
  });

  it('keeps a refusal decided: a retry gets the same outcome, and the log holds the refusal', async () => {
    const path = createTemporaryPath('model-not-allowed', '.sqlite');
    cleanups.push(() => removeTemporaryPath(path));
    const stepped = createSteppedGenerate();
    const bureau = await openBureau({ generate: stepped.generate, path });
    const run = await startRun(bureau);
    await stepped.firstStepEntered;

    const first = await steer(bureau, run.sessionId, 'outside', GPT_4_1.model);
    const retry = await steer(bureau, run.sessionId, 'outside', GPT_4_1.model);

    expect(retry).toEqual(first);
    expect(first.outcome === 'rejected' && first.failure.reason).toBe('model-not-allowed');
    const session = await bureau.getSession(run.sessionId);
    const kv = bureau.kv!;
    const head = await readSteeringLogHead(kv, run.sessionId, session!.incarnation);
    const events = await readSteeringLogEntries(
      kv,
      run.sessionId,
      session!.incarnation,
      0,
      head.sequence,
    );
    const refusals = events.filter((event) => event.type === 'refused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.type === 'refused' && refusals[0].outcome).toMatchObject({
      outcome: 'rejected',
      failure: { reason: 'model-not-allowed' },
    });
    stepped.releaseFirstStep();
  });

  it('matches the provider as well as the model when the override names one', async () => {
    const stepped = createSteppedGenerate();
    const bureau = await openBureau({
      generate: stepped.generate,
      catalog: twinModelCatalog(),
      allowed: [OPUS_5_5],
    });
    const run = await startRun(bureau);
    await stepped.firstStepEntered;

    const wrongProvider = await steer(
      bureau,
      run.sessionId,
      'twin',
      TWIN_OF_OPUS_5_5.model,
      TWIN_OF_OPUS_5_5.provider,
    );
    const rightProvider = await steer(
      bureau,
      run.sessionId,
      'original',
      OPUS_5_5.model,
      OPUS_5_5.provider,
    );
    const unspecified = await steer(bureau, run.sessionId, 'bare', OPUS_5_5.model);

    expect(wrongProvider.outcome === 'rejected' && wrongProvider.failure.reason).toBe(
      'model-not-allowed',
    );
    expect(rightProvider.outcome).toBe('accepted');
    expect(unspecified.outcome).toBe('accepted');
    stepped.releaseFirstStep();
  });

  it('rejects a provider-qualified override whose provider does not serve the model', async () => {
    const stepped = createSteppedGenerate();
    const bureau = await openBureau({ generate: stepped.generate });
    const run = await startRun(bureau);
    await stepped.firstStepEntered;

    const outcome = await steer(bureau, run.sessionId, 'mismatch', OPUS_5.model, 'openai');

    expect(outcome.outcome).toBe('rejected');
    stepped.releaseFirstStep();
  });
});

describe('an idle session takes a model override', () => {
  it('admits it as accepted, where pause is still session-terminal', async () => {
    const bureau = await openBureau();
    const run = await startRun(bureau);
    await waitForRunState(bureau, run.id);

    const model = await steer(bureau, run.sessionId, 'idle-model', OPUS_5.model, OPUS_5.provider);
    const pause = await bureau.submitSteeringCommand(run.sessionId, {
      id: 'idle-pause',
      principal: 'alice',
      requestedValue: { target: 'pause' },
    });

    expect(model.outcome).toBe('accepted');
    expect(pause).toEqual({ outcome: 'session-terminal', sessionId: run.sessionId });
  });

  it('still keeps a model the agent does not allow out of an idle session', async () => {
    const bureau = await openBureau();
    const run = await startRun(bureau);
    await waitForRunState(bureau, run.id);

    const outcome = await steer(bureau, run.sessionId, 'idle-outside', GPT_4_1.model);

    expect(outcome.outcome === 'rejected' && outcome.failure.reason).toBe('model-not-allowed');
  });
});

describe('a switched model reaches the provider call', () => {
  it('is used from the live run’s next step and by the session’s later runs', async () => {
    const stepped = createSteppedGenerate();
    const bureau = await openBureau({ generate: stepped.generate });
    const run = await startRun(bureau);
    await stepped.firstStepEntered;

    const outcome = await steer(bureau, run.sessionId, 'switch', OPUS_5.model, OPUS_5.provider);
    expect(outcome.outcome).toBe('accepted');
    stepped.releaseFirstStep();
    await waitForRunState(bureau, run.id);

    const second = await startRun(bureau, run.sessionId);
    await waitForRunState(bureau, second.id);

    // Step 0 of the first run was already running; its next step and both of the second run's use the override.
    expect(stepped.observed).toEqual([
      { model: undefined, provider: undefined },
      { model: 'claude-opus-5', provider: 'anthropic' },
      { model: 'claude-opus-5', provider: 'anthropic' },
      { model: 'claude-opus-5', provider: 'anthropic' },
    ]);
  });

  it('is used by a run that starts after a restart', async () => {
    const path = createTemporaryPath('model-restart', '.sqlite');
    cleanups.push(() => removeTemporaryPath(path));
    const first = createSteppedGenerate();
    const bureau = await openBureau({ generate: first.generate, path });
    const run = await startRun(bureau);
    await first.firstStepEntered;
    await steer(bureau, run.sessionId, 'switch', OPUS_5.model, OPUS_5.provider);
    first.releaseFirstStep();
    await waitForRunState(bureau, run.id);
    await bureau.dispose();

    const second = createSteppedGenerate();
    second.releaseFirstStep();
    const restarted = await openBureau({ generate: second.generate, path });
    const resumed = await startRun(restarted, run.sessionId);
    await waitForRunState(restarted, resumed.id);

    expect(second.observed[0]).toEqual({ model: 'claude-opus-5', provider: 'anthropic' });
    expect(await restarted.getSessionSteering(run.sessionId)).toEqual({
      model: { provider: 'anthropic', model: 'claude-opus-5' },
      configVersion: 1,
    });
  });
});
