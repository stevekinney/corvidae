/**
 * `bureau.tasks.explanation.generate` and `.get` over a real Bureau and its handler (COR-2534): a
 * model writes the longer explanation of a failed agent run when asked, it is stored with the model,
 * the time and its cost, what the model is sent holds names and facts and none of what the run took
 * in or gave back, a stored one reads again without a model call, and neither operation is on MCP.
 */
import {
  createAgent,
  createMockGenerate,
  type GenerateFunction,
  type InputDetector,
  stopWhen,
} from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import {
  answering,
  openBureau,
  type OpenedBureau,
  OWNER,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';
import { AGENT_STEP, FAST_SCHEDULE } from '../../testing/workflow-file-fixtures.test-support.ts';
import { serveWorkflows } from './workflows-fixtures.test-support.ts';
import {
  tasksExplanationGenerateOperation,
  tasksExplanationGetOperation,
} from './tasks-model-explanation-operation.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** The run's private error text, which the workspace conformance inventory names as the sentinel. */
const ERROR_TEXT = 'PRIVATE-MODEL-EXPLANATION-2f7d';
const ARGUMENT_MARKER = 'argument-marker-5c0d12';
const RESULT_MARKER = 'result-marker-91ae3f';
const MESSAGE_MARKER = 'message-marker-c2d7b8';

const status = (response: RpcBody): unknown => response.error?.data?.httpStatus;

/** What the model writes: a structured answer, with the tokens it used. */
function modelReplies(
  texts: readonly string[],
  usage = { prompt: 1000, completion: 500, total: 1500 },
) {
  return createMockGenerate(
    texts.map((text) => ({ content: JSON.stringify({ text }), toolCalls: [], usage })),
  );
}

const lookup = createTool({
  name: 'lookup-customer',
  description: 'Looks a customer up',
  input: z.object({ query: z.string() }),
  execute: async () => ({ found: RESULT_MARKER }),
});

const chargeCard = createTool({
  name: 'charge-card',
  description: 'Charges a card',
  input: z.object({ secret: z.string() }),
  execute: async () => {
    throw new Error(`${ERROR_TEXT}: declined`);
  },
});

/** An agent that looks a customer up, then fails at the tool that charges the card. */
function failingAgent() {
  let turn = 0;
  return createAgent({
    name: 'charger',
    generate: async () => {
      turn += 1;
      return turn === 1
        ? {
            content: '',
            toolCalls: [
              { id: 'call-1', name: 'lookup-customer', arguments: { query: ARGUMENT_MARKER } },
            ],
          }
        : {
            content: '',
            toolCalls: [
              { id: 'call-2', name: 'charge-card', arguments: { secret: ARGUMENT_MARKER } },
            ],
          };
    },
    stopWhen: stopWhen.noToolCalls(),
    toolbox: createToolbox([lookup, chargeCard]),
    executeOptions: { errorMode: 'failFast' },
  });
}

async function open(
  options: {
    readonly generate?: ReturnType<typeof modelReplies>;
    readonly withoutProvider?: boolean;
  } = {},
): Promise<OpenedBureau> {
  const opened = await openBureau({
    agents: { charger: failingAgent() },
    bureauOptions: {
      models:
        options.withoutProvider === true
          ? {}
          : { generate: (): GenerateFunction => options.generate ?? modelReplies(['It failed.']) },
    },
  });
  cleanups.push(() => opened.dispose());
  return opened;
}

/**
 * Everything a model was handed, whatever its shape, as one string; a structure that refers to
 * itself is read once.
 */
function serialized(calls: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(calls, (_key, value: unknown) => {
    if (typeof value !== 'object' || value === null) return value;
    if (seen.has(value)) return undefined;
    seen.add(value);
    return value;
  });
}

/** A task's status, or `undefined` for one the Bureau does not hold. */
async function statusOf(opened: OpenedBureau, taskId: string): Promise<string | undefined> {
  const task = await opened.bureau.tasks.get(taskId);
  return task?.status;
}

/** What the task's record holds of a model's explanation. */
async function storedExplanation(opened: OpenedBureau, taskId: string) {
  const record = await opened.bureau.internals.taskRegistry.record(taskId);
  return record?.modelExplanation;
}

/** What a task says it has used and cost: the run's own, never the explanation's. */
async function usageOf(opened: OpenedBureau, taskId: string) {
  const task = await opened.bureau.tasks.get(taskId);
  return task?.usage;
}

/** The text of the explanation an operation answered. */
function textOf(response: RpcBody): string | undefined {
  return (response.result as { explanation: { text: string } | null } | undefined)?.explanation
    ?.text;
}

/** Starts the failing agent as alice and waits until its task has failed. */
async function failedTask(opened: OpenedBureau): Promise<string> {
  const handle = await opened.bureau.tasks.start('charger', `charge it ${MESSAGE_MARKER}`, {
    principal: OWNER.alice,
  });
  await waitUntil(async () => (await statusOf(opened, handle.id)) === 'failed', {
    message: `task ${handle.id} failed`,
  });
  await opened.bureau.internals.taskRegistry.flush();
  return handle.id;
}

const generate = (opened: OpenedBureau, runId: string, key = 'alice-key'): Promise<RpcBody> =>
  rpc(opened.handler, 'bureau.tasks.explanation.generate', { runId }, key);
const read = (opened: OpenedBureau, runId: string, key = 'alice-key'): Promise<RpcBody> =>
  rpc(opened.handler, 'bureau.tasks.explanation.get', { runId }, key);

describe('bureau.tasks.explanation.generate', () => {
  it('AC1: stores the text on the task with the model’s name, the time and its cost', async () => {
    const replies = modelReplies(['The card was declined by the network.']);
    const opened = await open({ generate: replies });
    const taskId = await failedTask(opened);

    const response = await generate(opened, taskId);

    expect(response.error).toBeUndefined();
    const stored = await storedExplanation(opened, taskId);
    expect(stored).toBeDefined();
    expect(response.result).toEqual({ explanation: stored });
    expect(stored?.text).toBe('The card was declined by the network.');
    expect(stored?.model).toBe('anthropic/claude-haiku-5-5');
    expect(Number.isNaN(Date.parse(stored?.generatedAt ?? ''))).toBe(false);
    const row = opened.bureau.models
      .catalog()
      .descriptors.find(
        (candidate) => candidate.provider === 'anthropic' && candidate.model === 'claude-haiku-5-5',
      );
    const pricing = row?.pricing;
    expect(pricing).toBeDefined();
    expect(stored?.costUsd).toBeCloseTo(
      (1000 / 1_000_000) * pricing!.inputPerMillionTokens +
        (500 / 1_000_000) * pricing!.outputPerMillionTokens,
      10,
    );
  });

  it('AC2: sends the stored facts and the step names, the status and the error message, and none of what the run took in or gave back', async () => {
    const replies = modelReplies(['It failed.']);
    const opened = await open({ generate: replies });
    const taskId = await failedTask(opened);
    // The markers are on the task, so their absence below is the request's doing.
    const history = JSON.stringify(await opened.bureau.internals.taskRegistry.history(taskId));
    expect(history).toContain(MESSAGE_MARKER);

    const response = await generate(opened, taskId);

    expect(response.error).toBeUndefined();
    expect(replies.callCount).toBe(1);
    const request = serialized(replies.calls);
    expect(request).toContain('charge-card');
    expect(request).toContain(ERROR_TEXT);
    // The step the run failed at, with its status (the context is JSON inside the request's JSON).
    expect(request).toMatch(/charge-card\\+",\\+n\s*\\*"status\\+": \\+"failed/);
    for (const marker of [ARGUMENT_MARKER, RESULT_MARKER, MESSAGE_MARKER]) {
      expect(request).not.toContain(marker);
    }
    // The strings in the facts are named as data, not as instructions.
    expect(request).toContain('untrusted text');
  });

  it('AC2: names the guardrail that halted the run, and its outcome, without the text it flagged', async () => {
    const replies = modelReplies(['A guardrail stopped it.']);
    const detector: InputDetector = {
      name: 'sentinel-card',
      detect: async (input) =>
        input.includes('FORBIDDEN-WORD')
          ? { triggered: true, category: 'prompt-injection', confidence: 0.9 }
          : { triggered: false, category: 'prompt-injection', confidence: 0 },
    };
    const opened = await openBureau({
      agents: {
        guarded: createAgent({
          name: 'guarded',
          generate: async () => ({ content: 'fine', toolCalls: [] }),
          stopWhen: stopWhen.noToolCalls(),
          guardrails: { mode: 'tripwire', input: { detectors: [detector] } },
        }),
      },
      bureauOptions: { models: { generate: () => replies } },
    });
    cleanups.push(() => opened.dispose());
    const handle = await opened.bureau.tasks.start('guarded', 'this is FORBIDDEN-WORD', {
      principal: OWNER.alice,
    });
    await waitUntil(async () => (await statusOf(opened, handle.id)) === 'failed', {
      message: 'the guarded run failed',
    });
    await opened.bureau.internals.taskRegistry.flush();

    const response = await generate(opened, handle.id);

    expect(response.error).toBeUndefined();
    const request = serialized(replies.calls);
    expect(request).toContain('sentinel-card');
    expect(request).toContain('tripwire');
    expect(request).not.toContain('FORBIDDEN-WORD');
  });

  it('AC3: a stored explanation reads again without a model call, and generating again replaces it', async () => {
    const replies = modelReplies(['First explanation.', 'Second explanation.']);
    const opened = await open({ generate: replies });
    const taskId = await failedTask(opened);
    const empty = await read(opened, taskId);
    expect(empty.result).toEqual({ explanation: null });

    const first = await generate(opened, taskId);
    const readOnce = await read(opened, taskId);
    const readTwice = await read(opened, taskId);

    expect(replies.callCount).toBe(1);
    expect(readOnce.result).toEqual(first.result);
    expect(readTwice.result).toEqual(first.result);

    const second = await generate(opened, taskId);
    expect(replies.callCount).toBe(2);
    expect(textOf(second)).toBe('Second explanation.');
    const readAfter = await read(opened, taskId);
    expect(textOf(readAfter)).toBe('Second explanation.');
    expect(replies.callCount).toBe(2);
  });

  it('AC4: with no provider connected it is a fault whose remediation names connecting a provider, and stores nothing', async () => {
    const opened = await open({ withoutProvider: true });
    const taskId = await failedTask(opened);

    const response = await generate(opened, taskId);

    expect(response.result).toBeUndefined();
    expect(response.error?.data).toMatchObject({ capability: 'generate' });
    expect(String(response.error?.data?.['remediation'])).toContain('Connect a provider');
    expect(await storedExplanation(opened, taskId)).toBeUndefined();
  });

  it('AC7: the cost is the explanation’s own and the run’s usage.costUsd is unchanged', async () => {
    const opened = await open();
    const taskId = await failedTask(opened);
    const before = await usageOf(opened, taskId);

    const response = await generate(opened, taskId);

    expect(response.error).toBeUndefined();
    const explanation = (response.result as { explanation: { costUsd: number | null } })
      .explanation;
    expect(explanation.costUsd).toBeGreaterThan(0);
    const after = await usageOf(opened, taskId);
    expect(after).toEqual(before);
    expect(after?.costUsd ?? null).toBe(before?.costUsd ?? null);
    // The explanation's cost is kept on the explanation, apart from the run's.
    const kept = await storedExplanation(opened, taskId);
    expect(kept?.costUsd).toBe(explanation.costUsd);
  });

  it('AC8: neither operation is on MCP', () => {
    for (const operation of [tasksExplanationGenerateOperation, tasksExplanationGetOperation]) {
      expect(BUREAU_HANDLER_OPERATIONS).toContain(operation);
      expect(operation.mcpExposable).toBe(false);
    }
  });

  it('AC9: the run’s chat, which holds the user’s turns and the agent’s, does not hold the text', async () => {
    const opened = await open({ generate: modelReplies(['GENERATED-TEXT-6a1f.']) });
    const taskId = await failedTask(opened);
    const task = await opened.bureau.tasks.get(taskId);

    await generate(opened, taskId);

    const context = await opened.bureau.contexts.get(task!.contextId, { principal: OWNER.alice });
    // The chat is there to be read: it holds what the person said, and not what the model wrote.
    expect(JSON.stringify(context)).toContain(MESSAGE_MARKER);
    expect(JSON.stringify(context)).not.toContain('GENERATED-TEXT-6a1f');
    expect(
      JSON.stringify(await opened.bureau.internals.taskRegistry.history(taskId)),
    ).not.toContain('GENERATED-TEXT-6a1f');
  });
});

describe('bureau.tasks.explanation for an instance of a workflow file', () => {
  it('has no task to keep an explanation on: nothing stored on read, and a fault on generate', async () => {
    const served = await serveWorkflows(cleanups, {
      agents: {
        writer: createAgent({
          name: 'writer',
          generate: async () => {
            throw new Error('the writer is down');
          },
        }),
      },
    });
    await served.bureau.workflows!.create('digest', {
      agent: 'writer',
      trigger: FAST_SCHEDULE,
      steps: [AGENT_STEP],
    });
    await served.bureau.durableEngine()!.start('digest', null, { id: 'failed-digest' });
    await waitUntil(
      async () => {
        const run = await served.bureau.workflows!.getRun('failed-digest');
        return run?.status === 'failed';
      },
      { message: 'the instance failed' },
    );

    const read = await rpc(
      served.keyed,
      'bureau.tasks.explanation.get',
      { runId: 'failed-digest' },
      'operator-key',
    );
    const generated = await rpc(
      served.keyed,
      'bureau.tasks.explanation.generate',
      { runId: 'failed-digest' },
      'operator-key',
    );

    expect(read.result).toEqual({ explanation: null });
    expect(generated.result).toBeUndefined();
    expect(generated.error?.data).toMatchObject({ reason: 'run-has-no-task' });
    expect(String(generated.error?.data?.['remediation'])).toContain('runs explain');
  });
});

describe('bureau.tasks.explanation access and refusals', () => {
  it('refuses a run that did not fail, with the not-failed fault, and asks no model', async () => {
    const replies = modelReplies(['never']);
    const opened = await openBureau({
      generate: answering('Done.'),
      bureauOptions: { models: { generate: () => replies } },
    });
    cleanups.push(() => opened.dispose());
    const handle = await opened.bureau.tasks.start('default', 'go', { principal: OWNER.alice });
    await waitUntil(async () => (await statusOf(opened, handle.id)) === 'completed', {
      message: 'completed',
    });

    const response = await generate(opened, handle.id);

    expect(response.result).toBeUndefined();
    expect(response.error?.data).toMatchObject({ reason: 'run-not-failed' });
    expect(replies.callCount).toBe(0);
  });

  it('answers a caller who does not own the run as a missing run and asks no model', async () => {
    const replies = modelReplies(['never']);
    const opened = await open({ generate: replies });
    const taskId = await failedTask(opened);

    const bob = await generate(opened, taskId, 'bob-key');
    expect(bob.result).toBeUndefined();
    expect(status(bob)).toBe(404);
    expect(status(await read(opened, taskId, 'bob-key'))).toBe(404);
    expect(JSON.stringify(bob)).not.toContain(ERROR_TEXT);
    // Reading any owner's tasks does not spend tokens on them.
    const reader = await generate(opened, taskId, 'tasks-reader-key');
    expect(status(reader)).toBe(404);
    expect(replies.callCount).toBe(0);

    const operator = await generate(opened, taskId, 'tasks-operator-key');
    expect(operator.error).toBeUndefined();
    expect(replies.callCount).toBe(1);
  });
});
