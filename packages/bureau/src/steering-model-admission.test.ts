/**
 * COR-1559 — Bureau admits a `model` steering override only for a model the session's agent
 * allows, decides it when it is admitted rather than at the step boundary, and applies it from
 * the run's next step and to the session's later runs, across a restart.
 */
import {
  createAgent,
  createModelCatalog,
  createRoutingGenerate,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { createTemporaryPath, removeTemporaryPath } from '@lostgradient/testing/temporary-path';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { waitForRunState } from './test';
import {
  appendSteeringLogEvent,
  readSteeringLogEntries,
  readSteeringLogHead,
  type SteeringLogEvent,
} from './steering-log';
import {
  createSteppedGenerate,
  GPT_4_1,
  noopTool,
  OPUS_5,
  OPUS_5_5,
  twinModels,
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
    catalog?: ReturnType<typeof twinModels>;
    allowed?: Parameters<typeof createAgent>[0]['allowedCandidates'];
  } = {},
) {
  const generate = options.generate ?? (async () => ({ content: 'ok', toolCalls: [] as never[] }));
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
    storage:
      options.path === undefined ? { type: 'memory' } : { type: 'sqlite', path: options.path },
    ...(options.durable === false ? {} : { durable: true }),
    ...(options.catalog === undefined ? {} : { models: options.catalog }),
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
      catalog: twinModels(),
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

describe('a Bureau that is shutting down', () => {
  it('throws for an in-process caller and logs nothing, so a retry after a restart is admitted normally', async () => {
    const path = createTemporaryPath('model-shutdown', '.sqlite');
    cleanups.push(() => removeTemporaryPath(path));
    const bureau = await openBureau({ path });
    const run = await startRun(bureau);
    await waitForRunState(bureau, run.id);
    const closing = bureau.dispose();

    const attempt = await steer(bureau, run.sessionId, 'during-shutdown', OPUS_5.model).then(
      () => undefined,
      (error: unknown) => error,
    );
    await closing;

    expect(attempt).toMatchObject({ code: 'CONFLICT' });
    const restarted = await openBureau({ path });
    const retry = await steer(restarted, run.sessionId, 'during-shutdown', OPUS_5.model);
    expect(retry.outcome).toBe('accepted');
  });
});

describe('a steering log written before the provider field existed', () => {
  it('still folds: a bare model override is desired state with an unspecified provider', async () => {
    const path = createTemporaryPath('model-legacy-log', '.sqlite');
    cleanups.push(() => removeTemporaryPath(path));
    const bureau = await openBureau({ path });
    const run = await startRun(bureau);
    await waitForRunState(bureau, run.id);
    const session = await bureau.getSession(run.sessionId);
    const kv = bureau.kv!;
    // The record exactly as the previous version wrote it: a bare model string, no provider.
    const legacy = JSON.parse(
      JSON.stringify({
        type: 'admit',
        command: {
          id: 'legacy-1',
          idOrigin: 'caller',
          sessionId: run.sessionId,
          principal: 'alice',
          requestedValue: { target: 'model', override: 'claude-opus-5' },
          requestedAt: new Date().toISOString(),
        },
        liveRunIds: [],
        now: new Date().toISOString(),
      }),
    ) as SteeringLogEvent;
    const head = await readSteeringLogHead(kv, run.sessionId, session!.incarnation);
    const appended = await appendSteeringLogEvent(
      kv,
      run.sessionId,
      session!.incarnation,
      head,
      legacy,
    );
    expect(appended.status).toBe('appended');

    const steering = await bureau.getSessionSteering(run.sessionId);

    expect(steering).toEqual({
      model: { provider: null, model: 'claude-opus-5' },
      configVersion: 1,
    });
  });
});

describe('a routed or opaque agent lists no models', () => {
  const rows = createModelCatalog().descriptors;
  const rowOf = (choice: { provider: string; model: string }) =>
    rows.find((row) => row.provider === choice.provider && row.model === choice.model)!;

  function routedAgent(used: string[]) {
    const route = (name: string, choice: { provider: string; model: string }) => ({
      name,
      generate: withBackendDescriptors(async () => {
        used.push(name);
        return { content: name, toolCalls: [] as never[] };
      }, [rowOf(choice)]),
    });
    return createAgent({
      name: 'routed',
      generate: createRoutingGenerate({
        routes: [route('fast', OPUS_5), route('smart', OPUS_5_5)],
        strategy: () => ({ route: 'smart', reason: 'its own choice' }),
        fallback: 'fast',
      }),
    });
  }

  async function open(agent: ReturnType<typeof createAgent>, name: string, withPolicy = false) {
    const bureau = await createBureau<AgentDefinitions>({
      agents: { [name]: agent },
      storage: { type: 'memory' },
      ...(withPolicy
        ? {
            modelPolicy: {
              policyRevision: 1,
              users: { 'fast-tier': { exactOverride: { model: 'claude-opus-5' } } },
            },
          }
        : {}),
    });
    cleanups.push(() => bureau.dispose());
    const run = await bureau.createRun({ message: 'go', agentName: name, principal: 'alice' });
    await waitForRunState(bureau, run.id);
    return { bureau, run };
  }

  it('refuses a model override for an opaque agent with model-not-allowed', async () => {
    const { bureau, run } = await open(
      createAgent({ name: 'opaque', generate: async () => ({ content: 'ok', toolCalls: [] }) }),
      'opaque',
    );

    const outcome = await steer(bureau, run.sessionId, 'opaque-switch', OPUS_5.model);

    expect(outcome).toMatchObject({
      outcome: 'rejected',
      failure: { reason: 'model-not-allowed' },
    });
  });

  it('refuses a model override for a routed agent with model-not-allowed', async () => {
    const used: string[] = [];
    const { bureau, run } = await open(routedAgent(used), 'routed');

    const model = await steer(bureau, run.sessionId, 'routed-switch', OPUS_5.model);

    expect(model).toMatchObject({ outcome: 'rejected', failure: { reason: 'model-not-allowed' } });
  });

  it('still runs on the model the routed agent’s own routing chooses', async () => {
    const used: string[] = [];
    await open(routedAgent(used), 'routed');

    expect(used).toEqual(['smart']);
  });

  it('does not refuse a model a policy profile resolves, for an opaque agent', async () => {
    const { bureau, run } = await open(
      createAgent({ name: 'opaque', generate: async () => ({ content: 'ok', toolCalls: [] }) }),
      'opaque',
      true,
    );

    const outcome = await bureau.submitSteeringCommand(run.sessionId, {
      id: 'by-policy',
      principal: 'alice',
      requestedValue: { target: 'model', policyRef: 'fast-tier' },
    });

    expect(outcome.outcome).toBe('accepted');
  });
});
