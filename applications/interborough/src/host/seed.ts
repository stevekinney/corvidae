/**
 * What a fresh Interborough has in it: six agents, one schedule, and one goal, and a validator that
 * never passes, which no goal names until somebody creates one.
 *
 * Every agent answers from a script, so a seeded agent calls no model and needs no provider key,
 * whatever providers the host is configured with. The scripts start over whenever the host does.
 * The agents are code, so {@link createSeededAgents} rebuilds them on every start; the schedule and
 * the goal are Bureau state, so {@link seedBureau} creates them once, under one claim on a record
 * in the host's storage, and a restart adds nothing.
 *
 * A task that names one of these agents (Chat, or `bureau.tasks.start(name, input)`) runs that
 * agent's script, tools, and stop conditions. The durable Bureau also offers every such run its
 * `requestHumanInput` tool, which it does by default.
 *
 * - `assistant`: answers every message with one fixed reply.
 * - `tool-runner`: looks an order up (a read-only tool), then asks to refund it (a mutating tool
 *   the toolbox holds for approval). The run stops on the pending approval, and the refund does
 *   not run until an operator approves it. The review's `runId` is the task's id and the task's
 *   context supplies the request context that signs the approval.
 * - `request-human-input`: calls `requestHumanInput` with its question and parks until an
 *   operator answers the review, then thanks them. The review carries the task's context id.
 * - `echo`: answers every message with the text of the last message it was sent. A reply that
 *   quotes parts of earlier replies reaches the model as Markdown block quotes ahead of the typed
 *   text, so the echo shows exactly what the agent received.
 * - `model-switcher`: a selectable agent over two models (`MODEL_SWITCHER_MODELS`), whose reply
 *   names the model that answered, so a session switched with `bureau.contexts.steer` shows which
 *   model each message ran on. It is offered the models the host's catalog holds: the two models
 *   need a configured provider, and a host with none offers no choice, so Chat shows no picker.
 * - `internal`: a plain agent that answers with a scripted bookkeeping reply.
 *
 * A schedule's fire runs its named agent too, so the seeded schedule runs `assistant`'s script.
 * There are no users and no webhook receiver.
 */

import {
  createToolApprovalHooks,
  ScheduleLocatorUnavailableError,
  type Bureau,
} from '@lostgradient/bureau';
import {
  createAgent,
  createModelCatalog,
  createScriptedGenerate,
  stopWhen,
  withBackendDescriptors,
  type GenerateFunction,
  type GenerateResponse,
  type ScriptedGenerateStep,
  type Validator,
} from '@lostgradient/operative';
import {
  scopedStorage,
  textValueStore,
  type ConditionalTextValueStore,
  type Storage,
} from '@lostgradient/storage';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

/** Every seeded agent, by name. */
export const SEEDED_AGENT_NAMES = [
  'assistant',
  'tool-runner',
  'request-human-input',
  'echo',
  'model-switcher',
  'internal',
] as const;

/** How many times a script repeats before it runs out. */
const SCRIPT_REPETITIONS = 200;

/** The description the seeded schedule is created with. */
export const SEEDED_SCHEDULE_DESCRIPTION = 'Daily summary';

/** The goal the seed creates. */
export const SEEDED_GOAL_RUN_IDENTIFIER = 'seeded-goal';

/** The validator the seeded goal names. */
export const SEEDED_VALIDATOR = { name: 'accepts-any-answer', version: '1' } as const;

/**
 * A validator that never passes, for a goal that is made to be cancelled: it waits on the attempt's
 * answer for as long as it is allowed to, so the goal stays `evaluating` until an operator cancels
 * it, and cancelling aborts it, which ends the goal as `canceled`. No goal names it until somebody
 * creates one, so nothing runs against it on a fresh host.
 */
export const NEVER_PASSING_VALIDATOR = { name: 'never-passes', version: '1' } as const;

function replyResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function callResponse(
  name: string,
  argumentsObject: Record<string, unknown>,
  id = `seeded-${name}`,
): GenerateResponse {
  return { content: '', toolCalls: [{ id, name, arguments: argumentsObject }] };
}

function reply(content: string): ScriptedGenerateStep {
  return { kind: 'respond', response: replyResponse(content) };
}

/** The signal the seeded `request-human-input` agent parks on, and the question it asks. */
export const HUMAN_INPUT_SIGNAL = 'environment';
/**
 * The question the seeded `request-human-input` agent asks the person while it is parked on its
 * signal.
 */
export const HUMAN_INPUT_PROMPT = 'Which environment should the release go to?';

/**
 * The script of `request-human-input`: it asks its question, and once the person's answer is the
 * last thing in the conversation (the user row a delivered signal appends) it thanks them. It
 * answers from where the conversation has got to, not from the run's step number, and gives each
 * question's call the number of the calls before it, because a tool call identifier names one call
 * in a session: a second question on a session that already holds the first one's call would
 * otherwise fail without ever ending the run's stream.
 */
function humanInputGenerate(): GenerateFunction {
  return async ({ conversation }) => {
    const messages = conversation.getMessages();
    const answer = messages.at(-1);
    if (answer?.role === 'user' && typeof answer.content === 'string') {
      if (answer.content.startsWith(`[signal:${HUMAN_INPUT_SIGNAL}]`)) {
        return replyResponse('Thanks, the release will go to the environment you named.');
      }
    }
    const asked = messages.filter((message) => message.toolCall !== undefined).length;
    return callResponse(
      'requestHumanInput',
      { signalName: HUMAN_INPUT_SIGNAL, prompt: HUMAN_INPUT_PROMPT },
      `seeded-requestHumanInput-${asked + 1}`,
    );
  };
}

/**
 * The models `model-switcher` allows, in the order a picker lists them: catalog rows of the
 * `anthropic` provider, by their exact model names. The first is the agent's default. A session is
 * switched to the second with `bureau.contexts.steer`. The script names a model and calls none.
 */
export const MODEL_SWITCHER_MODELS = [
  { provider: 'anthropic', model: 'claude-sonnet-5' },
  { provider: 'anthropic', model: 'claude-haiku-4-5' },
] as const;

/** What `model-switcher` says when `model` answered. */
export function modelSwitcherReply(model: string): string {
  return `This reply is from ${model}. It is scripted; no model was called.`;
}

/**
 * The script of `model-switcher`: it names the model its step was told to use, which is the model
 * the session was switched to, and the first of {@link MODEL_SWITCHER_MODELS} before any switch.
 * That first model's catalog row is attached to the script, which is how the Bureau knows the
 * agent's default (`bureau.agents.models`), so Chat can show the model a new session runs on.
 */
function modelSwitcherGenerate(): GenerateFunction {
  const [first] = MODEL_SWITCHER_MODELS;
  const row = createModelCatalog().descriptors.find(
    (descriptor) => descriptor.provider === first.provider && descriptor.model === first.model,
  );
  if (row === undefined) throw new Error(`The model catalog has no ${first.model} row.`);
  const generate: GenerateFunction = async ({ steering }) =>
    replyResponse(modelSwitcherReply(steering?.model ?? first.model));
  return withBackendDescriptors(generate, [row]);
}

/** What `echo` says when the conversation holds no user message with text to repeat. */
export const ECHO_NOTHING_TO_REPEAT = 'There was no message to repeat.';

/**
 * The script of `echo`: it repeats the text of the last user message, unchanged. Each turn answers
 * the message that began it, so a session of several turns echoes the newest one, not the first.
 */
function echoGenerate(): GenerateFunction {
  return async ({ conversation }) => {
    const last = conversation.getMessages().findLast((message) => message.role === 'user');
    return replyResponse(
      typeof last?.content === 'string' && last.content !== ''
        ? last.content
        : ECHO_NOTHING_TO_REPEAT,
    );
  };
}

/**
 * The script of `tool-runner`: it answers from where the turn has got to, not from the run's step
 * number, because the run that follows an approval is a new run on the same session and starts at
 * step 0. It looks the order up, then asks to refund it; once the refund's result is in the turn
 * (the operator approved it, or denied it) it reports what became of it. A later turn of the same
 * session starts from the lookup again.
 */
function toolRunnerGenerate(): GenerateFunction {
  return async ({ conversation }) => {
    const messages = conversation.getMessages();
    const lastUser = messages.findLastIndex((message) => message.role === 'user');
    const turn = messages.slice(lastUser + 1);
    // A tool call identifier names one call in a conversation, so each turn's calls carry the
    // number of the turn that makes them.
    const turnNumber = messages.filter((message) => message.role === 'user').length;
    const lookupId = `seeded-lookup-order-${turnNumber}`;
    const refundId = `seeded-issue-refund-${turnNumber}`;
    const resultOf = (callId: string) =>
      turn.find((message) => message.toolResult?.callId === callId)?.toolResult;
    const refund = resultOf(refundId);
    if (refund !== undefined && refund.outcome !== 'action_required') {
      return replyResponse(
        refund.outcome === 'success'
          ? 'Order order-1001 was refunded.'
          : 'The refund of order order-1001 was not issued.',
      );
    }
    if (resultOf(lookupId) !== undefined) {
      return callResponse('issue-refund', { orderId: 'order-1001', cents: 4200 }, refundId);
    }
    return callResponse('lookup-order', { orderId: 'order-1001' }, lookupId);
  };
}

/** `steps`, one run's worth, repeated so the agent can serve run after run. */
function repeated(steps: readonly ScriptedGenerateStep[]): ScriptedGenerateStep[] {
  return Array.from({ length: SCRIPT_REPETITIONS }, () => steps).flat();
}

function createLookupOrderTool() {
  return createTool({
    name: 'lookup-order',
    version: '1.0.0',
    description: 'Look up an order by its identifier.',
    input: z.object({ orderId: z.string() }),
    metadata: { readOnly: true },
    execute: async ({ orderId }) => ({ orderId, status: 'delivered', totalCents: 4200 }),
  });
}

/**
 * The tools an agent file may name in `tools`: the deployment's tool catalog. It holds the
 * read-only `lookup-order` tool. Only the read-only tool is listed here, not because an agent
 * file's tools cannot be held for an operator (a tool that changes something asks, unless the
 * file's `toolApproval` says otherwise), but because the seeded agents do not need more.
 */
export function createAgentFileTools() {
  return { 'lookup-order': createLookupOrderTool() };
}

function createToolRunnerToolbox(approvalSecret: string) {
  const lookupOrder = createLookupOrderTool();
  const issueRefund = createTool({
    name: 'issue-refund',
    version: '1.0.0',
    description: 'Refund an order. An operator approves each refund before it runs.',
    input: z.object({ orderId: z.string(), cents: z.number() }),
    metadata: { mutates: true, summary: 'Refund order {orderId} for {cents:usd-cents}' },
    execute: async ({ orderId, cents }) => ({ orderId, refundedCents: cents }),
  });
  // The same rule a file agent's tools follow with no `toolApproval` (COR-1913): a tool that
  // reads runs, and one that changes something waits for an operator.
  return createToolbox([lookupOrder, issueRefund], {
    approvalSecret,
    // Its own two tools only: the Bureau adds `requestHumanInput` and the like to a run.
    policy: createToolApprovalHooks(undefined, { tools: [lookupOrder.name, issueRefund.name] }),
  });
}

/**
 * The seeded agents. `assistantGenerate` replaces the `assistant`'s script, for a test that needs a
 * run to stay in flight. `approvalSecret` signs the refund approvals `tool-runner` raises; the host
 * keeps one per installation in Bungalow's secrets so a restart can still resolve a pending
 * review.
 */
export function createSeededAgents(approvalSecret: string, assistantGenerate?: GenerateFunction) {
  return {
    assistant: createAgent({
      name: 'assistant',
      description: 'Answers every message with the same scripted reply.',
      examples: ['Say hello'],
      generate:
        assistantGenerate ??
        createScriptedGenerate(
          repeated([
            reply('Hello from the assistant. This reply is scripted; no model was called.'),
          ]),
        ),
      stopWhen: stopWhen.noToolCalls(),
    }),
    'tool-runner': createAgent({
      name: 'tool-runner',
      description: 'Looks an order up, then asks for approval to refund it.',
      examples: ['Refund order 1234'],
      generate: toolRunnerGenerate(),
      toolbox: createToolRunnerToolbox(approvalSecret),
      stopWhen: [stopWhen.pendingApproval(), stopWhen.noToolCalls()],
    }),
    'request-human-input': createAgent({
      name: 'request-human-input',
      description: 'Asks a human which environment the release should go to.',
      examples: ['Ship the release'],
      generate: humanInputGenerate(),
      // The run ends on the request so it parks; once an operator answers it continues to the
      // reply, which has no tool call.
      stopWhen: [stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()],
    }),
    echo: createAgent({
      name: 'echo',
      description: 'Repeats the last message it was sent.',
      examples: ['Hello echo, say this back'],
      generate: echoGenerate(),
      stopWhen: stopWhen.noToolCalls(),
    }),
    'model-switcher': createAgent({
      name: 'model-switcher',
      description: 'Names the model it answers as, and can be switched between two.',
      examples: ['Which model are you?'],
      generate: modelSwitcherGenerate(),
      allowedCandidates: MODEL_SWITCHER_MODELS,
      stopWhen: stopWhen.noToolCalls(),
    }),
    internal: createAgent({
      name: 'internal',
      description: 'Answers with a scripted bookkeeping reply.',
      examples: ['Run the bookkeeping'],
      generate: createScriptedGenerate(
        repeated([reply('Internal bookkeeping is done. This reply is scripted.')]),
      ),
      stopWhen: stopWhen.noToolCalls(),
    }),
  };
}

/** The seeded agents' definitions, which type the Bureau built over them. */
export type SeededAgents = ReturnType<typeof createSeededAgents>;

/** The validators the Bureau needs for the seeded goal, and the one that never passes. */
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
    {
      identity: NEVER_PASSING_VALIDATOR,
      determinism: 'deterministic',
      // It answers only when the goal is cancelled, and then as cancelled, never as a pass.
      validate: (_input, signal) =>
        new Promise((resolve) => {
          if (signal.aborted) {
            resolve({ kind: 'canceled' });
            return;
          }
          signal.addEventListener('abort', () => resolve({ kind: 'canceled' }), { once: true });
        }),
    },
  ];
}

/** The Weft key prefix Interborough keeps its own records under, inside the host's database. */
export const INTERBOROUGH_STORAGE_PREFIX = 'app:interborough';

/**
 * The record, under {@link INTERBOROUGH_STORAGE_PREFIX}, of the seeded schedule's identifier. A
 * schedule is edited and renamed by operators, so nothing about it but its identifier says it is the
 * seeded one. While a start is creating the schedule the record holds `claimed:<uuid>` instead.
 */
export const SEEDED_SCHEDULE_KEY = 'seeded-schedule';

/** The seeded schedule was created, but the record no longer held this start's claim to be replaced by its identifier. */
export class SeededScheduleRecordLostError extends Error {
  constructor(scheduleId: string) {
    super(
      `Seeded schedule ${scheduleId} was created, but its claim on the "${SEEDED_SCHEDULE_KEY}" record was replaced first, so the record does not name it.`,
    );
    this.name = 'SeededScheduleRecordLostError';
  }
}

/**
 * Create the seeded schedule and goal unless they already exist. The schedule is recognised by the
 * identifier recorded when it was created, so an operator who renames or edits it, or deletes it,
 * does not get a second one on the next start.
 *
 * The record lives in the host's Weft `storage`, and every change to it is a conditional write, so
 * starts that overlap, in one process or two over one database, create the schedule once: only the
 * start whose write of `claimed:<uuid>` finds the record absent creates it. It then replaces its
 * claim with the identifier. When the schedule is not created (`create` throws, or returns
 * `undefined`) it removes its claim, and only its own, so the next start tries again. When `create`
 * throws `ScheduleLocatorUnavailableError`, the schedule is registered and only its summary could
 * not be read, so the start records the error's identifier in place of its claim and carries on.
 *
 * The seeded goal is created under the same claim: only the start that won it creates the goal, and
 * only after the schedule's outcome is settled, so a second host never loses the goal's controller
 * claim and logs it as an error. A start that loses the claim creates neither. The accepted window
 * is the claim's own: a crash after the claim and before the goal exists leaves the record present,
 * so no later start creates the goal, and a goal whose creation throws is not retried either.
 * Both leave the install without its seeded goal, the same as a crash leaves it without its
 * schedule. A start that finds a `claimed:` record left behind reports it through `warn`.
 *
 * Previous releases kept the identifier in the Bungalow secret `seeded-schedule-id`. That file is
 * not read, so an install that has it seeds one more schedule on its first start after this change.
 *
 * @param warn Receives a possibly stale claim. Defaults to `console.warn`.
 */
export async function seedBureau(
  bureau: Bureau<SeededAgents>,
  storage: Storage,
  warn: (message: string) => void = (message) => console.warn(message),
): Promise<void> {
  // `disposeUnderlyingStorage: false` because the host's storage outlives this call: nothing here closes the store.
  const records = textValueStore(scopedStorage(storage, INTERBOROUGH_STORAGE_PREFIX), {
    disposeUnderlyingStorage: false,
  });
  const key = SEEDED_SCHEDULE_KEY;
  const claim = `claimed:${crypto.randomUUID()}`;
  // Accepted window: a crash after this claim and before the identifier below is written leaves the
  // claim behind, and every later start finds the record present, so the install has no seeded
  // schedule (when the crash came before `create` returned) or an unrecorded one (after). Nothing
  // recovers a claim, because a claim cannot be told from one a live start is still using.
  const claimed = await records.conditionalBatch(
    [{ key, expectedValue: null }],
    [{ type: 'put', key, value: claim }],
  );
  if (!claimed) {
    // A start that lost the claim leaves both the schedule and the goal to the one that won it.
    const held = await records.get(key);
    if (held?.startsWith('claimed:') === true) {
      warn(
        `The "${key}" record holds a claim. It is stale only if no other host is starting right now: a start that crashed after claiming it never seeds the schedule or the goal, and nothing removes the claim. Delete the "${INTERBOROUGH_STORAGE_PREFIX}:${key}" record to seed again.`,
      );
    }
    return;
  }
  let created: Awaited<ReturnType<Bureau<SeededAgents>['schedules']['create']>>;
  let scheduleId: string | undefined;
  try {
    created = await bureau.schedules.create({
      description: SEEDED_SCHEDULE_DESCRIPTION,
      agentName: 'assistant',
      input: 'Summarize what happened yesterday.',
      spec: '0 9 * * *',
    });
    scheduleId = created?.id;
  } catch (error) {
    if (error instanceof ScheduleLocatorUnavailableError) {
      // The schedule is registered, so releasing the claim would seed a duplicate on the next start.
      scheduleId = error.scheduleId;
    } else {
      await releaseClaim(records, key, claim);
      throw error;
    }
  }
  if (scheduleId === undefined) {
    await releaseClaim(records, key, claim);
  } else {
    const recorded = await records.conditionalBatch(
      [{ key, expectedValue: claim }],
      [{ type: 'put', key, value: scheduleId }],
    );
    if (!recorded) throw new SeededScheduleRecordLostError(scheduleId);
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

/**
 * Remove `claim` from the record, and only if the record still holds it. A failure to remove it
 * leaves the claim, which is the accepted window above, so it does not hide the error that sent the
 * start here.
 */
async function releaseClaim(
  records: ConditionalTextValueStore,
  key: string,
  claim: string,
): Promise<void> {
  try {
    await records.conditionalBatch([{ key, expectedValue: claim }], [{ type: 'delete', key }]);
  } catch {
    // The caller rethrows the error that made the claim worth releasing.
  }
}
