import { HookRegistry } from '@lostgradient/lifecycle';
import {
  Engine,
  MemoryStorage,
  textValueStore,
  yieldToPortableEventLoop,
} from '@lostgradient/weft';
import { createTool, createToolbox, type ToolRequestContext } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls, pendingApproval, some } from '../conditions/predicates';
import {
  BudgetExceededError,
  ElicitationDeniedError,
  GuardrailTripwireError,
  MaximumStepsExceededError,
} from '../errors';
import type { OperativeHookMap } from '../hooks';
import type { FinishReason, GenerateFunction, RunOptions } from '../types';
import { createCheckpointStore } from './checkpoint-store';
import { createRunWorkflow } from './run-workflow';
import type { AgentRunWorkflowResult } from './run-workflow-result';
import { createStorageActivities } from './storage-activities';
import type { DurableRunDeps } from './types';

/**
 * COR-1627 — the outcome matrix of the durable loop: every way it ends or suspends, crossed with
 * the finish reason its result records, the error message it carries, whether it parks first, and
 * how many steps it committed. The loop carries no finish reason until it ends: a natural step
 * exhaustion is decided at the loop's exit, and a park is a suspension with no reason yet, so a
 * run that parks and then settles, or that throws a step-limit error while a park is pending, is
 * never mistaken for a run that ran out of steps.
 *
 * The in-process loop has no parks; its rows are the `maximum-steps-failure.test.ts` and
 * `loop.test.ts` cases. The wakeup park's answer branch is the AB-45 cases in
 * `run-workflow.test.ts`, which need a durable timer; it shares the gate under test here with the
 * human-wait park.
 */

type DepsRef = { ref: DurableRunDeps | undefined };
type Counter = { calls: number };

type Expected = {
  readonly finishReason: FinishReason;
  /** The serialized message of the error the run ended on, or `undefined` when it ended on none. */
  readonly errorMessage: string | undefined;
  /** Whether the run parks on a human wait before it ends. */
  readonly parks: boolean;
  readonly steps: number;
  readonly generateCalls: number;
  readonly content?: string;
};

type Scenario = {
  readonly name: string;
  readonly maximumSteps: number;
  readonly options: (counter: Counter, toolbox: DurableRunDeps['toolbox']) => RunOptions;
  /** The toolbox the run executes with; `plain` when the scenario names none. */
  readonly toolbox?: (deps: DepsRef) => DurableRunDeps['toolbox'];
  readonly expected: Expected;
};

const SIGNAL = 'answer';

const nextTool = createTool({
  name: 'next',
  description: 'Asks for one more step',
  input: z.object({}),
  execute: async () => 'ok',
});

const chargeTool = createTool({
  name: 'charge',
  version: '1.0.0',
  description: 'Charges a card, which needs an approval',
  input: z.object({}),
  execute: async () => 'charged',
});

/** A `requestHumanInput` stand-in: parks the run on `SIGNAL`, as the real tool does. */
function humanInputTool(deps: DepsRef) {
  return createTool({
    name: 'requestHumanInput',
    description: 'Parks the run until a human answers',
    input: z.object({}),
    execute: async () => {
      if (deps.ref !== undefined) deps.ref.pendingHumanWait = { signalName: SIGNAL };
      return 'parked';
    },
  });
}

function plain(deps: DepsRef): DurableRunDeps['toolbox'] {
  return createToolbox([nextTool, humanInputTool(deps)]);
}

/** Every `charge` call waits on an approval, so its result is `action_required`. */
function approvalGated(deps: DepsRef): DurableRunDeps['toolbox'] {
  return createToolbox([nextTool, humanInputTool(deps), chargeTool], {
    approvalSecret: 'outcome-matrix-secret',
    policy: {
      beforeExecute: ({ toolName }) =>
        toolName === 'charge'
          ? {
              allow: false as const,
              status: 'needs_approval' as const,
              reason: 'Operator approval required',
              action: { message: 'Approve the charge' },
            }
          : { allow: true as const },
    },
  });
}

const call = (name: string) => ({ name, arguments: {} });

/** The request identity an approval binds to; Bureau supplies one for every run it executes. */
const requestContext: ToolRequestContext = {
  authority: {
    principalId: 'operator',
    tenantId: 'matrix-tenant',
    ownerId: 'operator',
    capabilities: [],
    authorizationRevision: '1',
  },
  audience: 'tenant',
  agentId: 'matrix',
  runId: 'matrix-run',
};

/** A model that answers `responses[step]`, or keeps asking for a step when it runs out. */
function script(
  counter: Counter,
  responses: ReadonlyArray<ReturnType<GenerateFunction> extends Promise<infer T> ? T : never>,
): GenerateFunction {
  return async () => {
    const index = counter.calls;
    counter.calls += 1;
    return responses[index] ?? { content: `step ${index}`, toolCalls: [call('next')] };
  };
}

function throwing(counter: Counter, error: () => Error): GenerateFunction {
  return async () => {
    counter.calls += 1;
    throw error();
  };
}

function throwingHook(error: () => Error): HookRegistry<OperativeHookMap> {
  const hooks = new HookRegistry<OperativeHookMap>();
  hooks.on('afterToolExecution', async () => {
    throw error();
  });
  return hooks;
}

const base = (toolbox: DurableRunDeps['toolbox'], generate: GenerateFunction): RunOptions => ({
  generate,
  toolbox,
  conversation: createConversationHistory(),
  stopWhen: noToolCalls(),
});

const tripwireDetail = {
  guardrailName: 'no-secrets',
  category: 'secrets',
  phase: 'input' as const,
  confidence: 0.9,
};

const scenarios: readonly Scenario[] = [
  {
    name: 'the loop runs out of steps',
    maximumSteps: 2,
    options: (counter, toolbox) => base(toolbox, script(counter, [])),
    expected: {
      finishReason: 'maximum-steps',
      errorMessage: undefined,
      parks: false,
      steps: 2,
      generateCalls: 2,
    },
  },
  {
    name: 'the loop runs out of steps and onMaximumSteps answers',
    maximumSteps: 2,
    options: (counter, toolbox) => ({
      ...base(toolbox, script(counter, [])),
      onMaximumSteps: async () => 'Out of steps.',
    }),
    expected: {
      finishReason: 'maximum-steps',
      errorMessage: undefined,
      parks: false,
      steps: 2,
      generateCalls: 2,
      content: 'Out of steps.',
    },
  },
  {
    name: 'onMaximumSteps throws a step-limit error of its own',
    maximumSteps: 2,
    options: (counter, toolbox) => ({
      ...base(toolbox, script(counter, [])),
      onMaximumSteps: async () => {
        throw new MaximumStepsExceededError(5);
      },
    }),
    expected: {
      finishReason: 'maximum-steps',
      errorMessage: 'Agent run exceeded maximumSteps (5).',
      parks: false,
      steps: 2,
      generateCalls: 2,
    },
  },
  {
    name: 'a stop condition fires',
    maximumSteps: 5,
    options: (counter, toolbox) =>
      base(toolbox, script(counter, [{ content: 'Done.', toolCalls: [] }])),
    expected: {
      finishReason: 'stop-condition',
      errorMessage: undefined,
      parks: false,
      steps: 1,
      generateCalls: 1,
      content: 'Done.',
    },
  },
  {
    name: 'the run is aborted while it generates',
    maximumSteps: 5,
    options: (counter, toolbox) => {
      const controller = new AbortController();
      return {
        ...base(toolbox, async () => {
          counter.calls += 1;
          controller.abort('stop now');
          return { content: 'Done.', toolCalls: [] };
        }),
        signal: controller.signal,
      };
    },
    expected: {
      finishReason: 'aborted',
      errorMessage: undefined,
      parks: false,
      steps: 0,
      generateCalls: 1,
    },
  },
  {
    name: 'generate throws a step-limit error',
    maximumSteps: 5,
    options: (counter, toolbox) =>
      base(
        toolbox,
        throwing(counter, () => new MaximumStepsExceededError(9)),
      ),
    expected: {
      finishReason: 'maximum-steps',
      errorMessage: 'Agent run exceeded maximumSteps (9).',
      parks: false,
      steps: 0,
      generateCalls: 1,
    },
  },
  {
    name: 'a tool hook throws a step-limit error',
    maximumSteps: 5,
    options: (counter, toolbox) => ({
      ...base(toolbox, script(counter, [])),
      hooks: throwingHook(() => new MaximumStepsExceededError(7)),
    }),
    expected: {
      finishReason: 'maximum-steps',
      errorMessage: 'Agent run exceeded maximumSteps (7).',
      parks: false,
      steps: 0,
      generateCalls: 1,
    },
  },
  {
    // Codex P2 on run-workflow-park.ts: the park the step registered must not hold a run that
    // then failed, whatever the reason it failed with.
    name: 'a tool hook throws a step-limit error after requestHumanInput parked',
    maximumSteps: 5,
    options: (counter, toolbox) => ({
      ...base(toolbox, script(counter, [{ content: '', toolCalls: [call('requestHumanInput')] }])),
      hooks: throwingHook(() => new MaximumStepsExceededError(7)),
    }),
    expected: {
      finishReason: 'maximum-steps',
      errorMessage: 'Agent run exceeded maximumSteps (7).',
      parks: false,
      steps: 0,
      generateCalls: 1,
    },
  },
  {
    name: 'generate throws a plain error',
    maximumSteps: 5,
    options: (counter, toolbox) =>
      base(
        toolbox,
        throwing(counter, () => new Error('the model failed')),
      ),
    expected: {
      finishReason: 'error',
      errorMessage: 'the model failed',
      parks: false,
      steps: 0,
      generateCalls: 1,
    },
  },
  {
    name: 'generate throws a budget error',
    maximumSteps: 5,
    options: (counter, toolbox) =>
      base(
        toolbox,
        throwing(counter, () => new BudgetExceededError('token limit reached')),
      ),
    expected: {
      finishReason: 'budget-exceeded',
      errorMessage: 'token limit reached',
      parks: false,
      steps: 0,
      generateCalls: 1,
    },
  },
  {
    name: 'generate throws an elicitation denial',
    maximumSteps: 5,
    options: (counter, toolbox) =>
      base(
        toolbox,
        throwing(counter, () => new ElicitationDeniedError('the user declined')),
      ),
    expected: {
      finishReason: 'elicitation-denied',
      errorMessage: 'the user declined',
      parks: false,
      steps: 0,
      generateCalls: 1,
    },
  },
  {
    name: 'generate trips a guardrail',
    maximumSteps: 5,
    options: (counter, toolbox) =>
      base(
        toolbox,
        throwing(counter, () => new GuardrailTripwireError('guardrail tripped', tripwireDetail)),
      ),
    expected: {
      finishReason: 'tripwire',
      errorMessage: 'guardrail tripped',
      parks: false,
      steps: 0,
      generateCalls: 1,
    },
  },
  {
    name: 'requestHumanInput parks the run and the answer continues it',
    maximumSteps: 5,
    options: (counter, toolbox) =>
      base(
        toolbox,
        script(counter, [
          { content: '', toolCalls: [call('requestHumanInput')] },
          { content: 'Thanks.', toolCalls: [] },
        ]),
      ),
    expected: {
      finishReason: 'stop-condition',
      errorMessage: undefined,
      parks: true,
      steps: 2,
      generateCalls: 2,
      content: 'Thanks.',
    },
  },
  {
    name: 'a step that stops also parks, and the answer continues the run',
    maximumSteps: 5,
    options: (counter, toolbox) => ({
      ...base(
        toolbox,
        script(counter, [
          { content: 'Asking.', toolCalls: [call('requestHumanInput')] },
          { content: 'Thanks.', toolCalls: [] },
        ]),
      ),
      stopWhen: () => true,
    }),
    expected: {
      finishReason: 'stop-condition',
      errorMessage: undefined,
      parks: true,
      steps: 2,
      generateCalls: 2,
      content: 'Thanks.',
    },
  },
  {
    // The verifier's reproduction: an approval the stop conditions do not stop on. Without a
    // stop, the answer continues the run, as the in-process loop continues past an
    // `action_required` row it was not told to stop on.
    name: 'requestHumanInput parks beside an approval the stop conditions ignore',
    maximumSteps: 5,
    toolbox: approvalGated,
    options: (counter, toolbox) => ({
      ...base(
        toolbox,
        script(counter, [
          { content: '', toolCalls: [call('requestHumanInput'), call('charge')] },
          { content: 'Thanks.', toolCalls: [] },
        ]),
      ),
      executeOptions: { requestContext },
    }),
    expected: {
      finishReason: 'stop-condition',
      errorMessage: undefined,
      parks: true,
      steps: 2,
      generateCalls: 2,
      content: 'Thanks.',
    },
  },
  {
    // COR-855: the step stopped on the approval, so the answer settles the run and the approval
    // is the next thing it offers.
    name: 'requestHumanInput parks beside an approval the run stops on',
    maximumSteps: 5,
    toolbox: approvalGated,
    options: (counter, toolbox) => ({
      ...base(
        toolbox,
        script(counter, [{ content: '', toolCalls: [call('requestHumanInput'), call('charge')] }]),
      ),
      stopWhen: some(pendingApproval(), noToolCalls()),
      executeOptions: { requestContext },
    }),
    expected: {
      finishReason: 'stop-condition',
      errorMessage: undefined,
      parks: true,
      steps: 1,
      generateCalls: 1,
    },
  },
];

type CheckpointStore = ReturnType<typeof createCheckpointStore>;
type EngineOf = Awaited<ReturnType<typeof createEngine>>;
type Handle = Awaited<ReturnType<EngineOf['start']>>;

async function createEngine(storage: MemoryStorage, checkpointStore: CheckpointStore) {
  const activities = createStorageActivities(checkpointStore);
  return Engine.create({
    storage,
    recover: false,
    workflows: { agentRun: createRunWorkflow(checkpointStore) },
    activities: {
      saveCursor: activities.saveCursor,
      saveConversation: activities.saveConversation,
      recordStep: activities.recordStep,
    },
  });
}

async function withEngine<T>(
  body: (engine: EngineOf, checkpointStore: CheckpointStore) => Promise<T>,
): Promise<T> {
  const storage = new MemoryStorage();
  const checkpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const engine = await createEngine(storage, checkpointStore);
  try {
    return await body(engine, checkpointStore);
  } finally {
    engine[Symbol.dispose]();
  }
}

type Outcome = { readonly parked: boolean; readonly summary?: AgentRunWorkflowResult };

/**
 * Drives the run until it settles or parks. A park is a workflow still `running` after its
 * step committed with a human wait registered, and that stays running once the park gate has
 * had every chance to settle it instead: a run that fails with a park pending settles within a
 * few turns of the commit, so a run still running well after it is parked.
 */
async function settleOrPark(
  handle: Handle,
  checkpointStore: CheckpointStore,
  runId: string,
  deps: DepsRef,
): Promise<Outcome> {
  const result = handle.result();
  result.catch(() => undefined);
  let parkedSince: number | undefined;
  for (let turn = 0; turn < 400; turn += 1) {
    await yieldToPortableEventLoop();
    const snapshot = await handle.snapshot();
    if (snapshot !== null && snapshot.status !== 'running') {
      return { parked: false, summary: (await result) as AgentRunWorkflowResult };
    }
    if (deps.ref?.pendingHumanWait !== undefined && parkedSince === undefined) {
      // The transcript the step saved is in the checkpoint whatever the step's outcome, so the
      // park gate runs within a few turns of this read, whether the step committed or failed.
      const checkpoint = await checkpointStore.loadCheckpoint(runId);
      if (checkpoint.conversation !== null) parkedSince = turn;
    }
    if (parkedSince !== undefined && turn - parkedSince >= 60) return { parked: true };
  }
  throw new Error(`Run "${runId}" neither settled nor parked`);
}

afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('the outcome matrix of the durable loop (COR-1627)', () => {
  for (const scenario of scenarios) {
    it(`records the outcome when ${scenario.name}`, async () => {
      await withEngine(async (engine, checkpointStore) => {
        const deps: DepsRef = { ref: undefined };
        const counter: Counter = { calls: 0 };
        const toolbox = (scenario.toolbox ?? plain)(deps);
        const services: DurableRunDeps = {
          toolbox,
          options: scenario.options(counter, toolbox),
        };
        deps.ref = services;
        const runId = `outcome-${scenarios.indexOf(scenario)}`;
        const handle = await engine.start(
          'agentRun',
          {
            runId,
            sessionId: runId,
            agentName: 'matrix',
            prompt: 'go',
            maximumSteps: scenario.maximumSteps,
          },
          { id: runId, services },
        );

        let outcome = await settleOrPark(handle, checkpointStore, runId, deps);
        expect(outcome.parked).toBe(scenario.expected.parks);
        if (outcome.parked) {
          // The tool wrote the wait on the deps object, which the workflow never clears; cleared
          // here so only the run's settlement ends the wait for the answer's continuation.
          services.pendingHumanWait = undefined;
          await engine.signal(runId, SIGNAL, { approved: true });
          outcome = await settleOrPark(handle, checkpointStore, runId, deps);
          expect(outcome.parked).toBe(false);
        }

        const summary = outcome.summary!;
        expect({
          finishReason: summary.finishReason,
          errorMessage: summary.errorMessage,
          steps: summary.steps,
          generateCalls: counter.calls,
          ...(scenario.expected.content === undefined ? {} : { content: summary.content }),
        }).toEqual({
          finishReason: scenario.expected.finishReason,
          errorMessage: scenario.expected.errorMessage,
          steps: scenario.expected.steps,
          generateCalls: scenario.expected.generateCalls,
          ...(scenario.expected.content === undefined
            ? {}
            : { content: scenario.expected.content }),
        });
      });
    });
  }
});
