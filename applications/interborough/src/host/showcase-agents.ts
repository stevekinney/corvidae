/**
 * The built-in agents and tools of the showcase sample world (`tmp/design-review/decisions.md`):
 * Assistant, Echo, Tool runner, Request human input, Model switcher and Workflow author, and the
 * Lookup order, Issue refund and Triage refunds tools Tool runner holds. Only the showcase host
 * registers them, as `HostOptions.extraAgents` (`showcase.ts`), so they are built in rather than a
 * plugin's: the Demo plugin keeps its own copies under `demo:`, and the sample world keeps it
 * disabled.
 *
 * Every agent answers from a script, so the showcase never calls a model. Assistant and Echo are
 * scripted agents in the sample world; Tool runner, Request human input, Model switcher and Workflow
 * author stand in for agents that need a model, and their scripts tell the sample world's stories
 * (the refunds of orders 4472 and 4471, and the release question).
 *
 * @module showcase-agents
 */

import {
  createToolApprovalHooks,
  type BureauOwnTools,
  type ToolApprovalMode,
} from '@lostgradient/bureau';
import {
  createAgent,
  createModelCatalog,
  createScriptedGenerate,
  stopWhen,
  withBackendDescriptors,
  type GenerateFunction,
  type GenerateResponse,
} from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

import type { ExtraAgents } from './host.ts';

/** The identifiers of the six built-in agents, in the order the sample world lists them. */
export const SHOWCASE_AGENT_IDENTIFIERS = [
  'assistant',
  'echo',
  'tool-runner',
  'request-human-input',
  'model-switcher',
  'workflow-author',
] as const;

/** The built-in agents that are scripted in the sample world, so no provider gates them. */
export const SHOWCASE_SCRIPTED_AGENTS = ['assistant', 'echo'] as const;

/**
 * The secret that signs the refund approvals Tool runner raises. The toolbox that raised an
 * approval is the one that verifies it, so it is the same on every start of the showcase host, and
 * an approval raised before a restart can still be decided after it. It signs nothing that matters.
 */
export const SHOWCASE_APPROVAL_SECRET = 'showcase-approval-secret-7c41d2';

/** What Assistant says to every message. */
export const SHOWCASE_ASSISTANT_REPLY = 'Hello! How can I help?';

/** What Echo says when the conversation holds no user message with text to repeat. */
export const SHOWCASE_ECHO_NOTHING_TO_REPEAT = 'There was no message to repeat.';

/** The question Request human input asks, and the signal it parks on while it waits. */
export const SHOWCASE_HUMAN_INPUT = {
  signal: 'environment',
  prompt: 'Which environment should the release go to?',
} as const;

/** What Workflow author says: it drafts, and asks before it creates the file. */
export const SHOWCASE_WORKFLOW_AUTHOR_REPLY =
  'Here is a draft of the workflow. Say the word and I’ll create the file.';

/**
 * The models Model switcher can be switched between: rows of the `anthropic` provider's catalog,
 * the first its default. The sample world's Anthropic catalog lists Opus 5.5, Sonnet 5.5 and Haiku
 * 5.5; Model switcher is offered the last two.
 */
export const SHOWCASE_MODEL_SWITCHER_MODELS = [
  { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  { provider: 'anthropic', model: 'claude-haiku-5-5' },
] as const;

/**
 * The Bureau tools Workflow author holds, by the name an agent file uses, and how it asks for each:
 * Create workflow On changes, and Discover agents, which only reads, Never.
 */
export const SHOWCASE_WORKFLOW_AUTHOR_TOOLS: Readonly<Record<string, ToolApprovalMode>> = {
  'bureau:workflows-create': 'on-changes',
  'bureau:discover-agents': 'never',
};

/**
 * The orders the sample world knows: each total, in cents, and the day it was delivered. Lookup
 * order answers from it, and Tool runner refunds an order's whole total.
 */
export const SHOWCASE_ORDERS: Readonly<
  Record<string, { readonly totalCents: number; readonly delivered: string }>
> = {
  '4468': { totalCents: 2650, delivered: 'Oct 27' },
  '4471': { totalCents: 4200, delivered: 'Oct 31' },
  '4472': { totalCents: 1850, delivered: 'Oct 30' },
};

/** Why every refund in the sample world is owed. */
export const SHOWCASE_REFUND_REASON = 'Arrived damaged';

/** How Tool runner asks for each of its tools: Lookup order Never, Issue refund Always, Triage refunds On changes. */
export const SHOWCASE_TOOL_APPROVAL: Readonly<Record<string, ToolApprovalMode>> = {
  'lookup-order': 'never',
  'issue-refund': 'always',
  'triage-refunds': 'on-changes',
};

/** The read-only tool: looks an order up by its number. */
export function createShowcaseLookupOrderTool() {
  return createTool({
    name: 'lookup-order',
    version: '1.0.0',
    description: 'Look up an order by its number.',
    input: z.object({ orderId: z.string() }),
    metadata: { readOnly: true, title: 'Lookup order' },
    execute: async ({ orderId }) => {
      const order = SHOWCASE_ORDERS[orderId];
      return order === undefined
        ? { orderId, found: false }
        : { orderId, found: true, status: 'delivered', ...order };
    },
  });
}

/**
 * The dangerous tool: refunds an order. Money leaves and it can't be undone, so its risk is
 * Dangerous wherever it shows (sweep S64), and a person approves every call.
 */
export function createShowcaseIssueRefundTool() {
  return createTool({
    name: 'issue-refund',
    version: '1.0.0',
    description: 'Refund an order to the original card. A person approves every refund.',
    input: z.object({ orderId: z.string(), cents: z.number(), reason: z.string() }),
    metadata: {
      mutates: true,
      dangerous: true,
      title: 'Issue refund',
      summary: 'Refund order {orderId} for {cents:usd-cents}?',
    },
    execute: async ({ orderId, cents }) => ({ orderId, refundedCents: cents }),
  });
}

/** The tool that sorts the refunds still waiting, which changes their queue, so it asks on changes. */
export function createShowcaseTriageRefundsTool() {
  return createTool({
    name: 'triage-refunds',
    version: '1.0.0',
    description: 'Sort the refunds that are still waiting into the right queue.',
    input: z.object({ since: z.string().optional() }),
    metadata: { mutates: true, title: 'Triage refunds' },
    execute: async () => ({ triaged: 0 }),
  });
}

/** A response that says `content` and calls no tool. */
function replyResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

/** A response that calls the tool `name` with `argumentsObject`, as the call `id`. */
function callResponse(
  name: string,
  argumentsObject: Record<string, unknown>,
  id: string,
): GenerateResponse {
  return { content: '', toolCalls: [{ id, name, arguments: argumentsObject }] };
}

/** `count` copies of one scripted reply, so a scripted agent can serve run after run. */
function repeatedReply(content: string, count = 200) {
  return Array.from({ length: count }, () => ({
    kind: 'respond' as const,
    response: replyResponse(content),
  }));
}

/** The text of a message's content, or an empty string when it holds none. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) =>
      typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string'
        ? part.text
        : '',
    )
    .join(' ');
}

/** The number of the order a message names ("order 4471"), or `undefined`. */
export function orderNamedIn(text: string): string | undefined {
  return /order\s+#?(\d+)/i.exec(text)?.[1];
}

/** Whether a message only asks to look an order up, not to refund it. */
function asksOnlyToLookUp(text: string): boolean {
  return /look\s*up/i.test(text) && !/refund/i.test(text);
}

/** What Tool runner says once a refund's result is in its turn. */
export function toolRunnerRefundReply(orderId: string, refunded: boolean): string {
  return refunded
    ? `Order ${orderId} was refunded to the original card.`
    : `The refund of order ${orderId} wasn’t issued.`;
}

/** What Tool runner says after looking an order up when it was asked only to look. */
export function toolRunnerLookupReply(orderId: string): string {
  const order = SHOWCASE_ORDERS[orderId];
  return order === undefined
    ? `I couldn’t find order ${orderId}.`
    : `Order ${orderId} was delivered on ${order.delivered}, for $${(order.totalCents / 100).toFixed(2)}.`;
}

/**
 * Tool runner's script: it answers from where the turn has got to, because the run that follows an
 * approval is a new run on the same session. It looks the order the message names up, then (unless
 * it was asked only to look) asks to refund the order's total; once the refund's result is in the
 * turn it says what became of it. Each turn's calls carry the turn's number, because a tool call
 * identifier names one call in a conversation.
 */
export function showcaseToolRunnerGenerate(): GenerateFunction {
  return async ({ conversation }) => {
    const messages = conversation.getMessages();
    const lastUser = messages.findLastIndex((message) => message.role === 'user');
    const request = textOf(messages[lastUser]?.content);
    const turn = messages.slice(lastUser + 1);
    const turnNumber = messages.filter((message) => message.role === 'user').length;
    const orderId = orderNamedIn(request) ?? '4471';
    const lookupId = `showcase-lookup-order-${String(turnNumber)}`;
    const refundId = `showcase-issue-refund-${String(turnNumber)}`;
    const resultOf = (callId: string) =>
      turn.find((message) => message.toolResult?.callId === callId)?.toolResult;
    const refund = resultOf(refundId);
    if (refund !== undefined && refund.outcome !== 'action_required') {
      return replyResponse(toolRunnerRefundReply(orderId, refund.outcome === 'success'));
    }
    if (resultOf(lookupId) !== undefined) {
      if (asksOnlyToLookUp(request)) return replyResponse(toolRunnerLookupReply(orderId));
      const cents = SHOWCASE_ORDERS[orderId]?.totalCents ?? 0;
      return callResponse(
        'issue-refund',
        { orderId, cents, reason: SHOWCASE_REFUND_REASON },
        refundId,
      );
    }
    return callResponse('lookup-order', { orderId }, lookupId);
  };
}

/**
 * Request human input's script: it asks its question, and once the person's answer is the last
 * message (the user row a delivered signal appends) it thanks them. Each question's call carries
 * the number of calls before it, so a second question in one session is a new call.
 */
export function showcaseHumanInputGenerate(): GenerateFunction {
  return async ({ conversation }) => {
    const messages = conversation.getMessages();
    const answer = messages.at(-1);
    if (
      answer?.role === 'user' &&
      textOf(answer.content).startsWith(`[signal:${SHOWCASE_HUMAN_INPUT.signal}]`)
    ) {
      return replyResponse('Thanks, the release will go to the environment you named.');
    }
    const asked = messages.filter((message) => message.toolCall !== undefined).length;
    return callResponse(
      'requestHumanInput',
      { signalName: SHOWCASE_HUMAN_INPUT.signal, prompt: SHOWCASE_HUMAN_INPUT.prompt },
      `showcase-requestHumanInput-${String(asked + 1)}`,
    );
  };
}

/** What Model switcher says when `model` answered. */
export function showcaseModelSwitcherReply(model: string): string {
  return `This reply is from ${model}. It is scripted; no model was called.`;
}

/**
 * Model switcher's script: it names the model its step was told to use. The first model's catalog
 * row is attached, which is how the Bureau knows the agent's default.
 */
export function showcaseModelSwitcherGenerate(): GenerateFunction {
  const [first] = SHOWCASE_MODEL_SWITCHER_MODELS;
  const row = createModelCatalog().descriptors.find(
    (descriptor) => descriptor.provider === first.provider && descriptor.model === first.model,
  );
  if (row === undefined) throw new Error(`The model catalog has no ${first.model} row.`);
  const generate: GenerateFunction = async ({ steering }) =>
    replyResponse(showcaseModelSwitcherReply(steering?.model ?? first.model));
  return withBackendDescriptors(generate, [row]);
}

/** Echo's script: it repeats the text of the last user message, unchanged. */
export function showcaseEchoGenerate(): GenerateFunction {
  return async ({ conversation }) => {
    const last = conversation.getMessages().findLast((message) => message.role === 'user');
    const text = textOf(last?.content);
    return replyResponse(text === '' ? SHOWCASE_ECHO_NOTHING_TO_REPEAT : text);
  };
}

/** Tool runner's toolbox: its three tools, asked for as {@link SHOWCASE_TOOL_APPROVAL} says. */
export function createShowcaseToolRunnerToolbox() {
  const tools = [
    createShowcaseLookupOrderTool(),
    createShowcaseIssueRefundTool(),
    createShowcaseTriageRefundsTool(),
  ];
  return createToolbox(tools, {
    approvalSecret: SHOWCASE_APPROVAL_SECRET,
    policy: createToolApprovalHooks(SHOWCASE_TOOL_APPROVAL, {
      tools: tools.map((tool) => tool.name),
    }),
  });
}

/**
 * Workflow author, built from the Bureau's own tools: it holds Create workflow and Discover agents
 * ({@link SHOWCASE_WORKFLOW_AUTHOR_TOOLS}), which only the Bureau can make, so the showcase host
 * passes it as `ExtraAgents.withBureauTools`. A tool the Bureau does not offer (Create workflow
 * without a workflow directory) is left out.
 */
export function showcaseWorkflowAuthor(tools: BureauOwnTools) {
  const held = Object.fromEntries(
    Object.keys(SHOWCASE_WORKFLOW_AUTHOR_TOOLS).flatMap((name) => {
      const tool = Object.hasOwn(tools, name) ? tools[name] : undefined;
      return tool === undefined ? [] : [[name, tool] as const];
    }),
  );
  return createAgent({
    name: 'workflow-author',
    description: 'Drafts a workflow from a description, and asks before it creates the file.',
    examples: ['Help me build a workflow that…'],
    generate: createScriptedGenerate(repeatedReply(SHOWCASE_WORKFLOW_AUTHOR_REPLY)),
    // Keyed by the names an agent file uses, so the catalog counts Workflow author among their users.
    tools: held,
    toolboxOptions: () => ({
      approvalSecret: SHOWCASE_APPROVAL_SECRET,
      policy: createToolApprovalHooks(SHOWCASE_WORKFLOW_AUTHOR_TOOLS, { tools: held }),
    }),
    stopWhen: stopWhen.noToolCalls(),
  });
}

/**
 * The six built-in agents, fresh, so no two hosts share a script's position. The showcase host
 * passes them as `HostOptions.extraAgents`: Workflow author among those built from the Bureau's
 * own tools.
 */
export function showcaseBuiltInAgents(): ExtraAgents {
  return {
    agents: {
      assistant: createAgent({
        name: 'assistant',
        description: 'Answers every message with the same scripted reply.',
        examples: ['Say hello'],
        generate: createScriptedGenerate(repeatedReply(SHOWCASE_ASSISTANT_REPLY)),
        stopWhen: stopWhen.noToolCalls(),
      }),
      echo: createAgent({
        name: 'echo',
        description: 'Repeats the last message it was sent.',
        examples: ['Hello echo, say this back'],
        generate: showcaseEchoGenerate(),
        stopWhen: stopWhen.noToolCalls(),
      }),
      'tool-runner': createAgent({
        name: 'tool-runner',
        description: 'Looks an order up, then asks for approval to refund it.',
        examples: ['Please refund order 4471, it arrived damaged.'],
        generate: showcaseToolRunnerGenerate(),
        toolbox: createShowcaseToolRunnerToolbox(),
        stopWhen: [stopWhen.pendingApproval(), stopWhen.noToolCalls()],
      }),
      'request-human-input': createAgent({
        name: 'request-human-input',
        description: 'Asks a human which environment the release should go to.',
        examples: ['Ship the release notes fix.'],
        generate: showcaseHumanInputGenerate(),
        // The run ends on the request so it parks; once a person answers it continues to the
        // reply, which has no tool call.
        stopWhen: [stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()],
      }),
      'model-switcher': createAgent({
        name: 'model-switcher',
        description: 'Names the model it answers as, and can be switched between two.',
        examples: ['Which model are you?'],
        generate: showcaseModelSwitcherGenerate(),
        allowedCandidates: SHOWCASE_MODEL_SWITCHER_MODELS,
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    withBureauTools: { 'workflow-author': showcaseWorkflowAuthor },
  };
}
