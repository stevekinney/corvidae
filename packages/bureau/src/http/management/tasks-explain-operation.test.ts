/**
 * `bureau.tasks.explain` over a real Bureau and its handler (COR-2532): why a failed agent run and a
 * failed workflow instance failed, from what is stored; the same answer every time with no provider
 * called; the guardrails that fired; a fault with a remediation for a run that did not fail; and the
 * access the run is read with. The private error text a failed run holds is never in the answer.
 */
import {
  createAgent,
  type GenerateFunction,
  type GuardrailsOptions,
  type InputDetector,
  stopWhen,
} from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import {
  answering,
  openBureau,
  type OpenedBureau,
  OWNER,
  parkingUntilAborted,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';
import { type Served, serveWorkflows } from './workflows-fixtures.test-support.ts';
import { tasksExplainOperation } from './tasks-explain-operation.ts';
import { AGENT_STEP, FAST_SCHEDULE } from '../../testing/workflow-file-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const SENTINEL = 'PRIVATE-EXPLAIN-ERROR-3b9e';
const ARGUMENT_MARKER = 'argument-marker-5c0d12';

const status = (response: RpcBody): unknown => response.error?.data?.httpStatus;

/** A generate function that fails with private text, and counts how often a provider was asked. */
function failingProvider(): { generate: GenerateFunction; readonly calls: () => number } {
  let calls = 0;
  return {
    generate: async () => {
      calls += 1;
      throw new Error(`the provider failed: ${SENTINEL}`);
    },
    calls: () => calls,
  };
}

const chargeCard = createTool({
  name: 'charge-card',
  description: 'Charges a card',
  input: z.object({ secret: z.string() }),
  execute: async () => {
    throw new Error(`the card network refused the charge: ${SENTINEL}`);
  },
});

/** An agent whose one tool call fails, ending the run at the tool. */
function toolFailureAgent() {
  return createAgent({
    name: 'tooler',
    generate: async () => ({
      content: '',
      toolCalls: [{ id: 'call-1', name: 'charge-card', arguments: { secret: ARGUMENT_MARKER } }],
    }),
    stopWhen: stopWhen.noToolCalls(),
    toolbox: createToolbox([chargeCard]),
    executeOptions: { errorMode: 'failFast' },
  });
}

/** Flags any input holding `word`, as a guardrail of the given mode. */
function sentinelGuardrail(word: string, mode: 'tripwire' | 'validate'): GuardrailsOptions {
  const detector: InputDetector = {
    name: `sentinel-${word}`,
    detect: async (input) =>
      input.includes(word)
        ? { triggered: true, category: 'prompt-injection', confidence: 0.9 }
        : { triggered: false, category: 'prompt-injection', confidence: 0 },
  };
  return mode === 'tripwire'
    ? { mode: 'tripwire', input: { detectors: [detector] } }
    : { mode: 'validate', input: { action: 'warn', detectors: [detector] } };
}

async function open(options: Parameters<typeof openBureau>[0]): Promise<OpenedBureau> {
  const opened = await openBureau(options);
  cleanups.push(() => opened.dispose());
  return opened;
}

/** Starts `agent` as alice and waits until its task has settled. */
async function settledTask(
  opened: OpenedBureau,
  agent: string,
  input: string,
  until: 'failed' | 'completed' = 'failed',
): Promise<string> {
  const handle = await opened.bureau.tasks.start(agent, input, { principal: OWNER.alice });
  await waitUntil(
    async () => {
      const task = await opened.bureau.tasks.get(handle.id);
      return task?.status === until;
    },
    { message: `task ${handle.id} is ${until}` },
  );
  await opened.bureau.internals.taskRegistry.flush();
  return handle.id;
}

const explain = (opened: OpenedBureau, runId: string, key = 'alice-key'): Promise<RpcBody> =>
  rpc(opened.handler, 'bureau.tasks.explain', { runId }, key);

describe('bureau.tasks.explain for a failed agent run', () => {
  it('AC1: answers the summary, the cause, the step, the tries, the verdicts, the remediation and the commands', async () => {
    const provider = failingProvider();
    const opened = await open({ generate: provider.generate });
    const taskId = await settledTask(opened, 'default', 'go');

    const response = await explain(opened, taskId);

    expect(response.error).toBeUndefined();
    expect(Object.keys(response.result!).toSorted()).toEqual(
      ['cause', 'nextCommands', 'remediation', 'step', 'summary', 'tries', 'verdicts'].toSorted(),
    );
    const view = await opened.bureau.tasks.get(taskId);
    expect(response.result).toMatchObject({
      cause: { code: view?.failure?.errorCode, kind: 'generate' },
      step: { label: 'model' },
      verdicts: [],
    });
    const result = response.result as { summary: string; remediation: string };
    expect(result.summary).toStartWith('The step "model" failed ');
    expect(result.summary).toEndWith(' while asking the model for a reply.');
    expect(result.remediation.length).toBeGreaterThan(0);
  });

  it('AC1: names the failing tool as the step, with the error’s code and kind', async () => {
    const opened = await open({ agents: { tooler: toolFailureAgent() } });
    const taskId = await settledTask(opened, 'tooler', 'go');

    const response = await explain(opened, taskId);

    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      cause: { kind: 'tool' },
      step: { label: 'charge-card' },
    });
    expect((response.result as { summary: string }).summary).toStartWith(
      'The step "charge-card" failed ',
    );
    expect((response.result as { summary: string }).summary).toEndWith(' while running a tool.');
  });

  it('AC2: two calls for one settled run are identical, and no provider is called by either', async () => {
    const provider = failingProvider();
    const opened = await open({ generate: provider.generate });
    const taskId = await settledTask(opened, 'default', 'go');
    const settledCalls = provider.calls();
    expect(settledCalls).toBeGreaterThan(0);

    const first = await explain(opened, taskId);
    const second = await explain(opened, taskId);

    expect(first.error).toBeUndefined();
    expect(second.result).toEqual(first.result);
    expect(provider.calls()).toBe(settledCalls);
  });

  it('never carries the error’s text or a tool’s arguments, which the task itself does hold', async () => {
    const opened = await open({ agents: { tooler: toolFailureAgent() } });
    const taskId = await settledTask(opened, 'tooler', 'go');
    const view = await opened.bureau.tasks.get(taskId);
    // The text is on the task, so its absence below is the projection's doing.
    expect(view?.statusMessage).toContain(SENTINEL);

    const response = await explain(opened, taskId);

    expect(response.error).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain(SENTINEL);
    expect(JSON.stringify(response)).not.toContain(ARGUMENT_MARKER);
  });

  it('classifies an agent run from its finish reason and error, with or without a durable engine', async () => {
    for (const bureauOptions of [{ durable: true }, { durable: false }]) {
      const opened = await open({ generate: failingProvider().generate, bureauOptions });
      const taskId = await settledTask(opened, 'default', 'go');
      const response = await explain(opened, taskId);
      expect([bureauOptions, response.error]).toEqual([bureauOptions, undefined]);
      expect(response.result).toMatchObject({
        cause: { category: 'application', kind: 'generate' },
        step: { label: 'model' },
        tries: null,
      });
      expect((response.result as { summary: string }).summary).toBe(
        'The step "model" failed because the code it ran raised an error while asking the model for a reply.',
      );
    }
  });
});

describe('bureau.tasks.explain verdicts', () => {
  it('AC4: lists the tripwire that halted the run, by name and outcome', async () => {
    const opened = await open({
      agents: {
        guarded: createAgent({
          name: 'guarded',
          generate: async () => ({ content: 'fine', toolCalls: [] }),
          stopWhen: stopWhen.noToolCalls(),
          guardrails: sentinelGuardrail('FORBIDDEN', 'tripwire'),
        }),
      },
    });
    const taskId = await settledTask(opened, 'guarded', 'this is FORBIDDEN');

    const response = await explain(opened, taskId);

    expect(response.error).toBeUndefined();
    expect(response.result?.['verdicts']).toEqual([
      { name: 'sentinel-FORBIDDEN', kind: 'tripwire', outcome: 'tripwire', step: 0 },
    ]);
    expect(response.result).toMatchObject({ cause: { code: 'TRIPWIRE', kind: 'policy' } });
    expect((response.result as { remediation: string }).remediation).toContain(
      'A guardrail halted this run',
    );
  });

  it('AC4: lists a validate-mode guardrail that acted and let a run that then failed go on', async () => {
    const provider = failingProvider();
    const opened = await open({
      agents: {
        warned: createAgent({
          name: 'warned',
          generate: provider.generate,
          stopWhen: stopWhen.noToolCalls(),
          guardrails: sentinelGuardrail('SUSPECT', 'validate'),
        }),
      },
    });
    const taskId = await settledTask(opened, 'warned', 'this is SUSPECT');

    const response = await explain(opened, taskId);

    expect(response.error).toBeUndefined();
    expect(response.result?.['verdicts']).toEqual([
      { name: 'sentinel-SUSPECT', kind: 'guardrail', outcome: 'warn', step: 0 },
    ]);
    expect((response.result as { remediation: string }).remediation).not.toContain('halted');
  });
});

describe('bureau.tasks.explain for a run that did not fail', () => {
  it('AC6: is a fault with a remediation for a completed run', async () => {
    const opened = await open({ generate: answering('Done.') });
    const taskId = await settledTask(opened, 'default', 'go', 'completed');

    const response = await explain(opened, taskId);

    expect(response.result).toBeUndefined();
    expect(response.error?.data).toMatchObject({ reason: 'run-not-failed' });
    expect(response.error?.message).toContain('"completed"');
    expect(response.error?.data?.['remediation']).toEqual(expect.any(String));
    expect(String(response.error?.data?.['remediation']).length).toBeGreaterThan(0);
  });

  it('AC6: is the same fault for a run that is still going', async () => {
    const opened = await open({ generate: parkingUntilAborted });
    const handle = await opened.bureau.tasks.start('default', 'go', { principal: OWNER.alice });

    const response = await explain(opened, handle.id);

    expect(response.result).toBeUndefined();
    expect(response.error?.data).toMatchObject({ reason: 'run-not-failed' });
    expect(response.error?.data?.['remediation']).toEqual(expect.any(String));
    handle.abort();
  });
});

describe('bureau.tasks.explain access', () => {
  it('answers a caller who does not own the run as a missing run, and reads no engine state for it', async () => {
    const opened = await open({ generate: failingProvider().generate });
    const taskId = await settledTask(opened, 'default', 'go');
    const read = spyOn(opened.bureau.durableEngine()!, 'get');

    const bob = await explain(opened, taskId, 'bob-key');
    expect(bob.result).toBeUndefined();
    expect(status(bob)).toBe(404);
    expect(read).not.toHaveBeenCalled();

    // The scope that reads any owner's tasks reads this too, and the engine is read then.
    const reader = await explain(opened, taskId, 'tasks-reader-key');
    expect(reader.error).toBeUndefined();
    expect(read).toHaveBeenCalled();

    expect(status(await explain(opened, 'nope'))).toBe(404);
  });

  it('answers the owner’s private error text to no one: the answer holds none even for the owner', async () => {
    const opened = await open({ generate: failingProvider().generate });
    const taskId = await settledTask(opened, 'default', 'go');
    for (const key of ['alice-key', 'tasks-reader-key']) {
      expect(JSON.stringify(await explain(opened, taskId, key))).not.toContain(SENTINEL);
    }
  });
});

describe('bureau.tasks.explain for a failed workflow run', () => {
  let writerDown = true;
  const serveFailing = async (extra: { guarded?: boolean } = {}): Promise<Served> => {
    writerDown = true;
    const served = await serveWorkflows(cleanups, {
      agents: {
        writer: createAgent({
          name: 'writer',
          generate: async () => {
            if (writerDown) throw new Error(`the writer is down: ${SENTINEL}`);
            return { content: 'written', toolCalls: [] };
          },
          ...(extra.guarded === true
            ? { guardrails: sentinelGuardrail('digest', 'tripwire') }
            : {}),
        }),
      },
    });
    await served.bureau.workflows!.create('digest', {
      agent: 'writer',
      trigger: FAST_SCHEDULE,
      steps: [AGENT_STEP],
    });
    return served;
  };

  async function failedRun(served: Served, runId: string): Promise<void> {
    await served.bureau.durableEngine()!.start('digest', null, { id: runId });
    await waitUntil(() => runStatusIs(served, runId, 'failed'), {
      message: `workflow run ${runId} failed`,
    });
  }

  async function runStatusIs(served: Served, runId: string, expected: string): Promise<boolean> {
    const run = await served.bureau.workflows!.getRun(runId);
    return run?.status === expected;
  }

  const explainRun = (served: Served, runId: string, key = 'operator-key'): Promise<RpcBody> =>
    rpc(served.keyed, 'bureau.tasks.explain', { runId }, key);

  it('AC1: answers the same fields for an instance of a workflow file, with the failed step', async () => {
    const served = await serveFailing();
    await failedRun(served, 'failed-digest');

    const response = await explainRun(served, 'failed-digest');

    expect(response.error).toBeUndefined();
    expect(Object.keys(response.result!).toSorted()).toEqual(
      ['cause', 'nextCommands', 'remediation', 'step', 'summary', 'tries', 'verdicts'].toSorted(),
    );
    const result = response.result as {
      summary: string;
      step: { index: number; label: string } | null;
      nextCommands: string[];
    };
    expect(result.step).not.toBeNull();
    expect(result.summary).toContain(`"${result.step!.label}"`);
    // The agent step failed, a step a retry can run again (COR-2533).
    expect(result.nextCommands).toEqual([
      'interborough runs get --kind workflow failed-digest',
      'interborough runs retry failed-digest',
    ]);
    expect(JSON.stringify(response)).not.toContain(SENTINEL);

    // The same answer again.
    const again = await explainRun(served, 'failed-digest');
    expect(again.result).toEqual(response.result);
  });

  it('AC4: lists the guardrail that fired in one of the instance’s steps', async () => {
    const served = await serveFailing({ guarded: true });
    await failedRun(served, 'guarded-digest');

    const response = await explainRun(served, 'guarded-digest');

    expect(response.error).toBeUndefined();
    expect(response.result?.['verdicts']).toEqual([
      { name: 'sentinel-digest', kind: 'tripwire', outcome: 'tripwire', step: 0 },
    ]);
  });

  it('AC6: is a fault with a remediation for an instance that completed', async () => {
    const served = await serveFailing();
    writerDown = false;
    await served.bureau.durableEngine()!.start('digest', null, { id: 'ok-digest' });
    await waitUntil(() => runStatusIs(served, 'ok-digest', 'completed'), {
      message: 'the digest completes',
    });

    const response = await explainRun(served, 'ok-digest');

    expect(response.result).toBeUndefined();
    expect(response.error?.data).toMatchObject({ reason: 'run-not-failed' });
    expect(response.error?.message).toContain('"completed"');
    expect(response.error?.data?.['remediation']).toEqual(expect.any(String));
  });

  it('answers a caller who may not read the instance as a missing run', async () => {
    const served = await serveFailing();
    await failedRun(served, 'private-digest');
    for (const key of ['alice-key', 'tasks-reader-key']) {
      const response = await explainRun(served, 'private-digest', key);
      expect([key, response.result]).toEqual([key, undefined]);
      expect([key, status(response)]).toEqual([key, 404]);
    }
    const reader = await explainRun(served, 'private-digest', 'workflows-reader-key');
    expect(reader.error).toBeUndefined();
  });

  it('COR-2533: suggests `runs retry` only to a caller the retry would let in', async () => {
    const served = await serveFailing();
    await failedRun(served, 'reader-digest');
    const reader = await explainRun(served, 'reader-digest', 'workflows-reader-key');
    expect(reader.error).toBeUndefined();
    expect((reader.result as { nextCommands: string[] }).nextCommands).toEqual([
      'interborough runs get --kind workflow reader-digest',
    ]);
    const operator = await explainRun(served, 'reader-digest');
    expect((operator.result as { nextCommands: string[] }).nextCommands).toContain(
      'interborough runs retry reader-digest',
    );
  });

  it('COR-2533: every command line it returns runs, and the retry mends the run', async () => {
    const served = await serveFailing();
    await failedRun(served, 'mended-digest');
    const lines = (await explainRun(served, 'mended-digest')).result as { nextCommands: string[] };
    // The retry's own acceptance is what offers the line: it answers the step the line will run.
    expect(await served.bureau.workflows!.retryableStep('mended-digest')).toBe(1);
    writerDown = false;
    const retried = await rpc(
      served.keyed,
      'bureau.workflows.runs.retry',
      { runId: 'mended-digest' },
      'operator-key',
    );
    expect(retried.error).toBeUndefined();
    expect(retried.result).toMatchObject({ runId: 'mended-digest', step: 1 });
    await waitUntil(() => runStatusIs(served, 'mended-digest', 'completed'), {
      message: 'the retried run completes',
    });
    expect(lines.nextCommands).toContain('interborough runs retry mended-digest');
    // Once it is running again there is nothing to retry, and nothing to explain.
    const after = await explainRun(served, 'mended-digest');
    expect(after.error?.data).toMatchObject({ reason: 'run-not-failed' });
  });
});

describe('bureau.tasks.explain when the engine holds nothing to read', () => {
  /** A host whose run is readable but whose engine state or timeline is absent, as it is with no durable engine. */
  function hostOf(options: {
    task?: unknown;
    state?: unknown;
    timeline?: unknown;
  }): Parameters<typeof tasksExplainOperation.invoke>[0]['host'] {
    return {
      tasks: { get: async () => options.task, ownerOf: async () => 'owner' },
      ownership: { mayAccess: () => true, runOwner: async () => 'owner' },
      workflows: { getRun: async () => ({ id: 'run-1' }) },
      runState: async () => options.state,
      runTimeline: async () => options.timeline,
      runVerdicts: async () => [],
    } as never;
  }

  const principal = { method: 'unauthenticated' } as never;
  const invoke = (host: ReturnType<typeof hostOf>) =>
    tasksExplainOperation.invoke({ input: { runId: 'run-1' }, host, principal } as never);

  it('is UnsupportedCapability, not run-not-failed, for a workflow instance with no engine state', async () => {
    const fault = await invoke(hostOf({ state: undefined })).catch((error: unknown) => error);
    expect(fault).toMatchObject({
      code: 'UnsupportedCapability',
      data: { capability: 'durable-engine' },
    });
  });

  it('is UnsupportedCapability for a failed workflow instance with no timeline', async () => {
    const fault = await invoke(
      hostOf({ state: { status: 'failed', failedStep: { index: 0, label: 'write' } } }),
    ).catch((error: unknown) => error);
    expect(fault).toMatchObject({
      code: 'UnsupportedCapability',
      data: { capability: 'durable-engine' },
    });
  });

  it('keeps tries null for a failed agent run with no timeline', async () => {
    const task = {
      status: 'failed',
      finishReason: 'error',
      failure: { step: { index: 0, label: 'model' }, errorCode: 'UNKNOWN', errorKind: 'generate' },
    };
    expect(await invoke(hostOf({ task }))).toMatchObject({
      tries: null,
      cause: { category: 'application', kind: 'generate' },
    });
  });

  it('is still run-not-failed for a workflow instance whose state says it did not fail', async () => {
    const fault = await invoke(hostOf({ state: { status: 'running' } })).catch(
      (error: unknown) => error,
    );
    expect(fault).toMatchObject({ code: 'Unprocessable', data: { reason: 'run-not-failed' } });
  });
});
