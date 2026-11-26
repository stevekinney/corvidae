/**
 * The scripts the demo agents answer from. Every demo agent answers from a script, so it calls no
 * model and needs no provider key, whatever providers the host is configured with. The scripts
 * start over whenever the host does.
 *
 * @module scripts
 */

import {
  withBackendDescriptors,
  type GenerateFunction,
  type GenerateResponse,
} from '@lostgradient/operative';
import { anthropicRows } from '@lostgradient/operative-anthropic';
import { type ScriptedGenerateStep } from '@lostgradient/operative/testing';
import { REFUND_TOOL_REVISION } from './refund-ledger.ts';

/** How many times a script repeats before it runs out. */
const SCRIPT_REPETITIONS = 200;

/** A response that says `content` and calls no tool. */
export function replyResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

/** A response that calls the tool `name` with `argumentsObject`. */
export function callResponse(
  name: string,
  argumentsObject: Record<string, unknown>,
  id = `seeded-${name}`,
): GenerateResponse {
  return { content: '', toolCalls: [{ id, name, arguments: argumentsObject }] };
}

/** A scripted step that answers `content`. */
export function reply(content: string): ScriptedGenerateStep {
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
export function humanInputGenerate(): GenerateFunction {
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
export function modelSwitcherGenerate(): GenerateFunction {
  const [first] = MODEL_SWITCHER_MODELS;
  const row = anthropicRows().find(
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
export function echoGenerate(): GenerateFunction {
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
export function toolRunnerGenerate(
  ledger: ReturnType<typeof import('./refund-ledger.ts').createRefundLedger>,
): GenerateFunction {
  return async ({ conversation, runId }) => {
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
          ? 'The refund for order order-1001 is pending with the processor.'
          : 'The refund of order order-1001 was not issued.',
      );
    }
    const userTurn = messages[lastUser];
    if (!userTurn || !runId) throw new Error('Refund admission requires a persisted turn and run');
    const merchant = `demo:${userTurn.id}`;
    const existing = await ledger.find(merchant, userTurn.id);
    if (existing && existing.existingRunId !== runId)
      return replyResponse(`Refund ${existing.id} is ${existing.status} in its original run.`);
    if (resultOf(lookupId) !== undefined) {
      await ledger.addCharge({
        merchant,
        order: 'order-1001',
        amount: 10000,
        currency: 'USD',
        paymentReference: `synthetic:${userTurn.id}`,
        providerAccount: 'demo',
      });
      const intent = await ledger.admit({
        merchant,
        commandId: userTurn.id,
        order: 'order-1001',
        amount: 4200,
        toolRevision: REFUND_TOOL_REVISION,
        owner: 'demo',
        existingRunId: runId,
      });
      if (intent.existingRunId !== runId)
        return replyResponse(`Refund ${intent.id} is ${intent.status} in its original run.`);
      return callResponse(
        'issue-refund',
        {
          refundId: intent.id,
          orderId: intent.order,
          cents: intent.amount,
          currency: intent.currency,
        },
        refundId,
      );
    }
    return callResponse('lookup-order', { orderId: 'order-1001' }, lookupId);
  };
}

/** `steps`, one run's worth, repeated so the agent can serve run after run. */
export function repeated(steps: readonly ScriptedGenerateStep[]): ScriptedGenerateStep[] {
  return Array.from({ length: SCRIPT_REPETITIONS }, () => steps).flat();
}
