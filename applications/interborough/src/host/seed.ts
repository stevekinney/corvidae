/**
 * What a fresh Interborough has in it: four agents, one schedule, and one goal.
 *
 * Every agent answers from a script, so the host calls no model and reads no provider key. The
 * scripts start over whenever the host does. The agents are code, so {@link createSeededAgents}
 * rebuilds them on every start; the schedule and the goal are Bureau state, so {@link seedBureau}
 * creates each only when the Bureau does not already hold it, and a restart adds nothing.
 *
 * A session run that names one of these agents (Chat, or `createRun({ agentName })`) runs that
 * agent's script, tools, and stop conditions. The host sets `humanInput: true`, so the Bureau also
 * offers every such run its `requestHumanInput` tool.
 *
 * - `assistant`: answers every message with one fixed reply.
 * - `tool-runner`: looks an order up (a read-only tool), then asks to refund it (a mutating tool
 *   the toolbox holds for approval). The run stops on the pending approval, and the refund does
 *   not run until an operator approves it. Through a session run the review's `runId` is that
 *   run's id and the session's request context signs the approval. `bureau.run('tool-runner')`
 *   has no session, so it signs with {@link LOCAL_REQUEST_CONTEXT} instead.
 * - `request-human-input`: calls `requestHumanInput` with its question and parks until an
 *   operator answers the review, then thanks them. Through a session run the review carries the
 *   session's id; through `bureau.run('request-human-input')` there is no session, so the review
 *   is addressed by its run id and resolves the same way.
 * - `internal`: a plain agent the host does not publish.
 *
 * What these agents do not cover: a schedule's fire and a goal's attempt pass their agent name
 * into the Bureau-wide runtime, so the seeded schedule and goal run the Bureau's own scripted
 * default and not `assistant`'s script. There are no users and no webhook receiver.
 */

import type { Bureau } from '@lostgradient/bureau';
import {
  createAgent,
  createScriptedGenerate,
  stopWhen,
  type GenerateFunction,
  type GenerateResponse,
  type ScriptedGenerateStep,
  type Validator,
} from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

/** Every seeded agent, by name. */
export const SEEDED_AGENT_NAMES = [
  'assistant',
  'tool-runner',
  'request-human-input',
  'internal',
] as const;

/** The agents the host publishes through the Bureau handler; `internal` stays private. */
export const PUBLISHED_AGENT_NAMES = ['assistant', 'tool-runner', 'request-human-input'] as const;

/** How many times a script repeats before it runs out. */
const SCRIPT_REPETITIONS = 200;

/** The description the seeded schedule is created with. */
export const SEEDED_SCHEDULE_DESCRIPTION = 'Daily summary';

/** The goal the seed creates. */
export const SEEDED_GOAL_RUN_IDENTIFIER = 'seeded-goal';

/** The validator the seeded goal names. */
export const SEEDED_VALIDATOR = { name: 'accepts-any-answer', version: '1' } as const;

function reply(content: string): ScriptedGenerateStep {
  return { kind: 'respond', response: { content, toolCalls: [] } };
}

function call(name: string, argumentsObject: Record<string, unknown>): ScriptedGenerateStep {
  const response: GenerateResponse = {
    content: '',
    toolCalls: [{ id: `seeded-${name}`, name, arguments: argumentsObject }],
  };
  return { kind: 'respond', response };
}

/** The signal the seeded `request-human-input` agent parks on, and the question it asks. */
export const HUMAN_INPUT_SIGNAL = 'environment';
export const HUMAN_INPUT_PROMPT = 'Which environment should the release go to?';

/**
 * A script that picks its response by the run's step number, so every run starts from its first
 * response however many runs came before, and a run that parks resumes at the next one. The last
 * response repeats if a run goes past the end.
 */
function byStep(steps: readonly ScriptedGenerateStep[]): GenerateFunction {
  return async ({ step }) => {
    const chosen = steps[Math.min(step, steps.length - 1)];
    if (chosen === undefined || chosen.kind !== 'respond') {
      throw new Error('A seeded script needs at least one response.');
    }
    return chosen.response;
  };
}

/** `steps`, one run's worth, repeated so the agent can serve run after run. */
function repeated(steps: readonly ScriptedGenerateStep[]): ScriptedGenerateStep[] {
  return Array.from({ length: SCRIPT_REPETITIONS }, () => steps).flat();
}

/**
 * The identity a signed approval binds to when `tool-runner` is dispatched with `bureau.run`: the
 * one local caller, acting through `tool-runner`. A catalog dispatch has no session to supply a
 * request context, and approving a tool call needs a request principal, tenant, audience, agent,
 * and run, so they are constants here. A session run ignores this and uses the session's own.
 */
const LOCAL_REQUEST_CONTEXT = {
  authority: {
    principalId: 'anonymous:local',
    tenantId: 'interborough',
    ownerId: 'anonymous:local',
    capabilities: [],
    authorizationRevision: '1',
  },
  audience: 'tenant',
  agentId: 'tool-runner',
  runId: 'tool-runner',
} as const;

function createToolRunnerToolbox(approvalSecret: string) {
  const lookupOrder = createTool({
    name: 'lookup-order',
    version: '1.0.0',
    description: 'Look up an order by its identifier.',
    input: z.object({ orderId: z.string() }),
    metadata: { readOnly: true },
    execute: async ({ orderId }) => ({ orderId, status: 'delivered', totalCents: 4200 }),
  });
  const issueRefund = createTool({
    name: 'issue-refund',
    version: '1.0.0',
    description: 'Refund an order. An operator approves each refund before it runs.',
    input: z.object({ orderId: z.string(), cents: z.number() }),
    metadata: { mutates: true },
    execute: async ({ orderId, cents }) => ({ orderId, refundedCents: cents }),
  });
  return createToolbox([lookupOrder, issueRefund], {
    approvalSecret,
    approvalPolicy: { mode: 'on-mutation' },
  });
}

/**
 * The seeded agents. `approvalSecret` signs the refund approvals `tool-runner` raises; the host
 * keeps one per installation in Bungalow's secrets so a restart can still resolve a pending
 * review.
 */
export function createSeededAgents(approvalSecret: string) {
  return {
    assistant: createAgent({
      name: 'assistant',
      description: 'Answers every message with the same scripted reply.',
      generate: createScriptedGenerate(
        repeated([reply('Hello from the assistant. This reply is scripted; no model was called.')]),
      ),
      stopWhen: stopWhen.noToolCalls(),
    }),
    'tool-runner': createAgent({
      name: 'tool-runner',
      description: 'Looks an order up, then asks for approval to refund it.',
      generate: byStep([
        call('lookup-order', { orderId: 'order-1001' }),
        call('issue-refund', { orderId: 'order-1001', cents: 4200 }),
        reply('Order order-1001 was refunded.'),
      ]),
      toolbox: createToolRunnerToolbox(approvalSecret),
      executeOptions: { requestContext: LOCAL_REQUEST_CONTEXT },
      stopWhen: [stopWhen.pendingApproval(), stopWhen.noToolCalls()],
    }),
    'request-human-input': createAgent({
      name: 'request-human-input',
      description: 'Asks a human which environment the release should go to.',
      generate: byStep([
        call('requestHumanInput', {
          signalName: HUMAN_INPUT_SIGNAL,
          prompt: HUMAN_INPUT_PROMPT,
        }),
        reply('Thanks, the release will go to the environment you named.'),
      ]),
      // The run ends on the request so it parks; once an operator answers it continues to the
      // reply, which has no tool call.
      stopWhen: [stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()],
    }),
    internal: createAgent({
      name: 'internal',
      description: 'An agent the host does not publish.',
      generate: createScriptedGenerate(
        repeated([reply('Internal bookkeeping is done. This reply is scripted.')]),
      ),
      stopWhen: stopWhen.noToolCalls(),
    }),
  };
}

/**
 * The model the Bureau itself runs when no catalog agent supplies one, such as for a schedule's
 * tick. It is a script like every agent's, so a fresh host still calls no model.
 */
export function createSeededGenerate() {
  return createScriptedGenerate(
    repeated([reply('This reply comes from the Bureau’s scripted default. No model was called.')]),
  );
}

/** The seeded agents' definitions, which type the Bureau built over them. */
export type SeededAgents = ReturnType<typeof createSeededAgents>;

/** The validators the Bureau needs for the seeded goal. */
export function createSeededValidators(): Validator[] {
  return [
    {
      identity: SEEDED_VALIDATOR,
      determinism: 'deterministic',
      validate: async (input) => ({
        kind: 'pass',
        evidence: [{ source: 'seed', detail: { content: input.result.content } }],
      }),
    },
  ];
}

/** The Bungalow entry that records the seeded schedule's identifier, beside the approval secret. */
export const SEEDED_SCHEDULE_RECORD_KEY = 'seeded-schedule-id';

/**
 * Where the seed remembers what it created. A schedule is edited and renamed by operators, so
 * nothing about it but its identifier says it is the seeded one.
 */
export type SeedRecord = {
  read(key: string): string | undefined;
  write(key: string, value: string): void;
};

/**
 * Create the seeded schedule and goal unless they already exist. The schedule is recognised by the
 * identifier recorded when it was created, so an operator who renames or edits it, or deletes it,
 * does not get a second one on the next start. The goal carries its own identifier.
 */
export async function seedBureau(bureau: Bureau<SeededAgents>, record: SeedRecord): Promise<void> {
  if (record.read(SEEDED_SCHEDULE_RECORD_KEY) === undefined) {
    const created = await bureau.createSchedule({
      description: SEEDED_SCHEDULE_DESCRIPTION,
      agentName: 'assistant',
      input: 'Summarize what happened yesterday.',
      spec: '0 9 * * *',
    });
    if (created !== undefined) record.write(SEEDED_SCHEDULE_RECORD_KEY, created.id);
  }
  await bureau.goals.create({
    goalRunId: SEEDED_GOAL_RUN_IDENTIFIER,
    agentName: 'assistant',
    prompt: 'Say hello.',
    identity: { name: 'say-hello', version: '1' },
    validator: SEEDED_VALIDATOR,
    bounds: { maximumAttempts: 1, maximumTotalSteps: 10 },
  });
}
