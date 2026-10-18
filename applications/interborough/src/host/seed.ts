/**
 * What a fresh Interborough has in it: four agents, one schedule, and one goal.
 *
 * Every agent answers from a script (`createScriptedGenerate`), so the host calls no model and
 * reads no provider key. The scripts are long enough for a development session and start over
 * whenever the host does. The agents are code, so {@link createSeededAgents} rebuilds them on
 * every start; the schedule and the goal are Bureau state, so {@link seedBureau} creates each only
 * when the Bureau does not already hold it, and a restart adds nothing.
 *
 * - `assistant`: answers every message with one fixed reply.
 * - `tool-runner`: looks an order up (a read-only tool), then asks to refund it (a mutating tool
 *   the toolbox holds for approval). The run stops on the pending approval, and the refund does
 *   not run until an operator approves it.
 * - `request-human-input`: asks a human a question and waits for the answer. It declares no input
 *   or output schema, so it takes free text and answers with free text. Bureau wires the
 *   `requestHumanInput` tool into the runs it creates itself and not yet into a catalog agent's,
 *   so this agent asks in its reply; it is where the tool call belongs once Bureau supports it.
 * - `internal`: a plain agent the host does not publish.
 *
 * There are no users and no webhook receiver.
 */

import type { Bureau } from '@lostgradient/bureau';
import {
  createAgent,
  createScriptedGenerate,
  stopWhen,
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

/** The schedule the seed creates, found again by its description. */
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

/** `steps`, one run's worth, repeated so the agent can serve run after run. */
function repeated(steps: readonly ScriptedGenerateStep[]): ScriptedGenerateStep[] {
  return Array.from({ length: SCRIPT_REPETITIONS }, () => steps).flat();
}

/**
 * The identity a signed approval binds to: the one local caller, acting through `tool-runner`.
 * Approving a tool call needs a request principal, tenant, audience, agent, and run, and a catalog
 * agent has one caller and one tenant, so they are constants here.
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
      generate: createScriptedGenerate(
        repeated([
          call('lookup-order', { orderId: 'order-1001' }),
          call('issue-refund', { orderId: 'order-1001', cents: 4200 }),
          reply('Order order-1001 was refunded.'),
        ]),
      ),
      toolbox: createToolRunnerToolbox(approvalSecret),
      executeOptions: { requestContext: LOCAL_REQUEST_CONTEXT },
      stopWhen: [stopWhen.pendingApproval(), stopWhen.noToolCalls()],
    }),
    'request-human-input': createAgent({
      name: 'request-human-input',
      description: 'Asks a human which environment the release should go to.',
      generate: createScriptedGenerate(
        repeated([reply('Which environment should the release go to? Reply with its name.')]),
      ),
      stopWhen: stopWhen.noToolCalls(),
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

/** Create the seeded schedule and goal unless the Bureau already holds them. */
export async function seedBureau(bureau: Bureau<SeededAgents>): Promise<void> {
  const schedules = await bureau.listSchedules();
  const scheduled = schedules?.items.some(
    (schedule) => schedule.description === SEEDED_SCHEDULE_DESCRIPTION,
  );
  if (scheduled === false || scheduled === undefined) {
    await bureau.createSchedule({
      description: SEEDED_SCHEDULE_DESCRIPTION,
      agentName: 'assistant',
      input: 'Summarize what happened yesterday.',
      spec: '0 9 * * *',
    });
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
