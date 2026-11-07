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
  type Validator,
  type ValidatorOutcome,
} from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

import type { ExtraAgents } from './host.ts';
import {
  humanInputAnsweredReply,
  lookupOrderResult,
  toolRunnerRefundAsk,
  toolRunnerRefundedReply,
} from './showcase-sentences.ts';

/**
 * The identifiers of the six built-in agents, in the order the sample world lists them, which is
 * the order a new chat offers them in. Workflow author is built from the Bureau's own tools, which
 * exist only once the Bureau does, so the Bureau lists it after the agents built up front; Echo and
 * Model switcher are registered the same way, after it, to keep this order.
 */
export const SHOWCASE_AGENT_IDENTIFIERS = [
  'assistant',
  'tool-runner',
  'request-human-input',
  'workflow-author',
  'echo',
  'model-switcher',
] as const;

/** The identifier of one of the six built-in agents of {@link SHOWCASE_AGENT_IDENTIFIERS}. */
export type ShowcaseAgentIdentifier = (typeof SHOWCASE_AGENT_IDENTIFIERS)[number];

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

/**
 * The question Request human input asks, the signal it parks on while it waits, and the answer it
 * takes: Staging or Production, each with the sentence that says what choosing it does, or
 * the person's own words. The schema is the payload every surface draws the question from.
 */
export const SHOWCASE_HUMAN_INPUT = {
  signal: 'environment',
  prompt: 'Which environment should the release go to?',
  /** What the agent says before it asks, in the same reply as the question. */
  preface: 'Before I ship it I need one answer.',
  answerSchema: {
    anyOf: [{ enum: ['staging', 'production'] }, { type: 'string', maxLength: 500 }],
    'x-allowOther': true,
    'x-labels': { staging: 'Staging', production: 'Production' },
    'x-descriptions': {
      staging: 'Deploys to the staging site',
      production: 'Deploys to the live site',
    },
  },
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
  Record<
    string,
    {
      readonly totalCents: number;
      readonly delivered: string;
      /** The day it shipped, when the sample world says (RunDetail's order 4468). */
      readonly shipped?: string;
      /** What the order is flagged for, when something is (the refund chat's order 4471). */
      readonly flagged?: string;
    }
  >
> = {
  '4398': { totalCents: 2725, delivered: 'Oct 28' },
  '4468': { totalCents: 1800, shipped: 'Oct 27', delivered: 'Oct 29' },
  '4471': { totalCents: 4200, delivered: 'Monday', flagged: 'damaged' },
  '4472': { totalCents: 1850, delivered: 'Oct 30' },
};

/** Why every refund in the sample world is owed. */
export const SHOWCASE_REFUND_REASON = 'Arrived damaged';

/**
 * What Tool runner answers a message that names no order: the start of a plan it never finishes in
 * the sample world, because the server restarts while it answers ("Rename the billing tables").
 */
export const SHOWCASE_TOOL_RUNNER_PLAN =
  'I’ll start with the invoices table, then the payments table, and check that every query still works.';

/** A moment in Tool runner's script, handed to {@link ShowcasePacing.toolRunner} before it answers. */
export interface ShowcaseToolRunnerMoment {
  /** What Tool runner is about to do: look an order up, ask to refund it, or answer in words. */
  readonly step: 'lookup' | 'refund-ask' | 'answer';
  /** The order the turn's message names, when it names one. */
  readonly orderId: string | undefined;
  /** The text of the turn's message. */
  readonly request: string;
  /** Aborted when the run is: a pace that waits must stop waiting then. */
  readonly signal: AbortSignal | undefined;
}

/** A moment in Assistant's script, handed to {@link ShowcasePacing.assistant} before it answers. */
export interface ShowcaseAssistantMoment {
  /** The text of the last user message, which a workflow step's message or a goal's prompt is too. */
  readonly request: string;
  /** Aborted when the run is: a pace that waits must stop waiting then. */
  readonly signal: AbortSignal | undefined;
}

/** A goal's check about to answer, handed to {@link ShowcasePacing.check}. */
export interface ShowcaseCheckMoment {
  /** The check's validator name, one of {@link SHOWCASE_GOAL_CHECKS}. */
  readonly check: string;
  /** Which attempt it judges, from zero. */
  readonly attemptIndex: number;
  /** Whether the attempt met the check. */
  readonly passed: boolean;
}

/**
 * How the sample world's seed paces the scripted agents and checks (`fixtures/sample-world-seed.ts`):
 * Tool runner awaits {@link ShowcasePacing.toolRunner} before each answer and Assistant
 * {@link ShowcasePacing.assistant}, so the seed can move its clock inside a run (the 4471 ask comes
 * 20 s after its run starts), hold an answer until the server stops, or fail one (Release notes'
 * step 2 on Oct 30); a goal's check awaits {@link ShowcasePacing.check} before it answers, so the
 * next attempt starts when the story says. Without pacing every answer comes at once.
 */
export interface ShowcasePacing {
  /** Awaited before each Tool runner answer; a rejection fails the answer, as an aborted one does. */
  readonly toolRunner?: (moment: ShowcaseToolRunnerMoment) => void | Promise<void>;
  /** Awaited before each Assistant answer; a rejection fails the answer with its message. */
  readonly assistant?: (moment: ShowcaseAssistantMoment) => void | Promise<void>;
  /** Awaited before a goal's check answers. */
  readonly check?: (moment: ShowcaseCheckMoment) => void | Promise<void>;
}

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
      return order === undefined ? `Order ${orderId} was not found.` : lookupOrderResult(order);
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

/** A response that calls the tool `name` with `argumentsObject`, as the call `id`, after saying `content`. */
function callResponse(
  name: string,
  argumentsObject: Record<string, unknown>,
  id: string,
  content = '',
): GenerateResponse {
  return { content, toolCalls: [{ id, name, arguments: argumentsObject }] };
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

/**
 * The answer a delivered signal carries, as a person reads it: the label of the choice the question
 * offered ("Staging" for `staging`), or the person's own words. The signal's content is its name
 * and the answer as JSON (`[signal:environment] "staging"`).
 */
export function answerNamedIn(content: string): string {
  const body = content.slice(content.indexOf(']') + 1).trim();
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value !== 'string') return body;
    const labels = SHOWCASE_HUMAN_INPUT.answerSchema['x-labels'] as Readonly<
      Record<string, string>
    >;
    return Object.hasOwn(labels, value) ? (labels[value] ?? value) : value;
  } catch {
    return body;
  }
}

/** What Tool runner says after looking an order up when it was asked only to look. */
export function toolRunnerLookupReply(orderId: string): string {
  const order = SHOWCASE_ORDERS[orderId];
  if (order === undefined) return `I couldn’t find order ${orderId}.`;
  const total = `$${(order.totalCents / 100).toFixed(2)}`;
  return order.shipped === undefined
    ? `Order ${orderId} was delivered on ${order.delivered}, for ${total}.`
    : `Order ${orderId} shipped on ${order.shipped} and was delivered on ${order.delivered}. The total was ${total}, paid by card.`;
}

/**
 * Tool runner's script: it answers from where the turn has got to, because the run that follows an
 * approval is a new run on the same session. It looks the order the message names up, then (unless
 * it was asked only to look) asks to refund the order's total, saying the order's note as it asks;
 * once the refund is approved its run says so and what it did
 * ({@link toolRunnerRefundedReply}), and a refund that was not issued ends the run with no reply. A message that names no order gets {@link SHOWCASE_TOOL_RUNNER_PLAN}.
 * Each turn's calls carry the turn's number, because a tool call identifier names one call in a
 * conversation. `pacing` is awaited before each answer.
 */
export function showcaseToolRunnerGenerate(pacing: ShowcasePacing = {}): GenerateFunction {
  return async ({ conversation, signal }) => {
    const messages = conversation.getMessages();
    const lastUser = messages.findLastIndex((message) => message.role === 'user');
    const request = textOf(messages[lastUser]?.content);
    const turn = messages.slice(lastUser + 1);
    const turnNumber = messages.filter((message) => message.role === 'user').length;
    const orderId = orderNamedIn(request);
    const pace = async (step: ShowcaseToolRunnerMoment['step']) =>
      pacing.toolRunner?.({ step, orderId, request, signal });
    if (orderId === undefined) {
      await pace('answer');
      return replyResponse(SHOWCASE_TOOL_RUNNER_PLAN);
    }
    const lookupId = `showcase-lookup-order-${String(turnNumber)}`;
    const refundId = `showcase-issue-refund-${String(turnNumber)}`;
    const resultOf = (callId: string) =>
      turn.find((message) => message.toolResult?.callId === callId)?.toolResult;
    const refund = resultOf(refundId);
    if (refund !== undefined && refund.outcome !== 'action_required') {
      await pace('answer');
      // An approved refund says so and what it did; a refund that was not issued says nothing.
      return replyResponse(
        refund.outcome === 'success'
          ? toolRunnerRefundedReply(SHOWCASE_ORDERS[orderId]?.totalCents ?? 0)
          : '',
      );
    }
    if (resultOf(lookupId) !== undefined) {
      if (asksOnlyToLookUp(request)) {
        await pace('answer');
        return replyResponse(toolRunnerLookupReply(orderId));
      }
      const order = SHOWCASE_ORDERS[orderId];
      await pace('refund-ask');
      return {
        ...callResponse(
          'issue-refund',
          { orderId, cents: order?.totalCents ?? 0, reason: SHOWCASE_REFUND_REASON },
          refundId,
        ),
        content: order === undefined ? '' : toolRunnerRefundAsk(orderId, order.totalCents),
      };
    }
    await pace('lookup');
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
      return replyResponse(humanInputAnsweredReply(answerNamedIn(textOf(answer.content))));
    }
    const asked = messages.filter((message) => message.toolCall !== undefined).length;
    return callResponse(
      'requestHumanInput',
      {
        signalName: SHOWCASE_HUMAN_INPUT.signal,
        prompt: SHOWCASE_HUMAN_INPUT.prompt,
        answerSchema: SHOWCASE_HUMAN_INPUT.answerSchema,
      },
      `showcase-requestHumanInput-${String(asked + 1)}`,
      SHOWCASE_HUMAN_INPUT.preface,
    );
  };
}

/** What Model switcher says when `model` answered. */
export function showcaseModelSwitcherReply(model: string): string {
  return `This reply is from ${model}. It is scripted; no model was called.`;
}

/**
 * The model a built-in agent that needs one runs on unless a chat says otherwise: Sonnet 5.5, the
 * row of the `anthropic` provider's catalog that Tool runner's saved version names.
 */
export const SHOWCASE_MODEL_AGENT_MODEL = {
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
} as const;

/**
 * Attaches {@link SHOWCASE_MODEL_AGENT_MODEL}'s catalog row to a scripted agent, as the Bureau reads
 * the model a code agent runs on (`bureau.agents.list`'s `media`). A scripted agent names no model,
 * so no provider gates it; this is what makes Tool runner, Request human input and Workflow author
 * agents that need one, which the sample world's no-provider frames require. The script still
 * answers, because the showcase never calls a model.
 */
export function onShowcaseModel(generate: GenerateFunction): GenerateFunction {
  const row = createModelCatalog().descriptors.find(
    (descriptor) =>
      descriptor.provider === SHOWCASE_MODEL_AGENT_MODEL.provider &&
      descriptor.model === SHOWCASE_MODEL_AGENT_MODEL.model,
  );
  if (row === undefined) {
    throw new Error(`The model catalog has no ${SHOWCASE_MODEL_AGENT_MODEL.model} row.`);
  }
  return withBackendDescriptors(generate, [row]);
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

/**
 * Assistant's script: it says {@link SHOWCASE_ASSISTANT_REPLY} to every message, once `pacing` has
 * let it ({@link ShowcasePacing.assistant}).
 */
export function showcaseAssistantGenerate(pacing: ShowcasePacing = {}): GenerateFunction {
  const scripted = createScriptedGenerate(repeatedReply(SHOWCASE_ASSISTANT_REPLY));
  return async (request) => {
    const last = request.conversation.getMessages().findLast((message) => message.role === 'user');
    await pacing.assistant?.({ request: textOf(last?.content), signal: request.signal });
    return scripted(request);
  };
}

/**
 * The checks the sample world's goals name (PageGoals), each a built-in validator of the showcase
 * host whose name says the check in words: "Reply says hello", "Notes mention the staging fix" and
 * "Summary lists every refund waiting for approval". Each looks for its phrase in the attempt's
 * answer.
 */
export const SHOWCASE_GOAL_CHECKS = {
  sayHello: { name: 'reply-says-hello', version: '1', phrase: 'hello' },
  stagingFix: { name: 'notes-mention-the-staging-fix', version: '1', phrase: 'staging fix' },
  waitingRefunds: {
    name: 'summary-lists-every-refund-waiting-for-approval',
    version: '1',
    phrase: 'waiting for approval',
  },
} as const;

/**
 * The goal checks of {@link SHOWCASE_GOAL_CHECKS} as validators: an attempt whose answer holds the
 * check's phrase passes, and one that doesn't fails with a retryable "Check not met", so the goal
 * tries again while it has attempts left. `pacing` is awaited before each answer.
 */
export function createShowcaseValidators(pacing: ShowcasePacing = {}): Validator[] {
  return Object.values(SHOWCASE_GOAL_CHECKS).map(({ name, version, phrase }) => ({
    identity: { name, version },
    determinism: 'deterministic',
    validate: async ({ result, attemptIndex }): Promise<ValidatorOutcome> => {
      const answer = result.content;
      const passed = answer.toLowerCase().includes(phrase);
      await pacing.check?.({ check: name, attemptIndex, passed });
      const evidence = [{ source: name, detail: { answer } }];
      return passed
        ? { kind: 'pass', evidence }
        : {
            kind: 'fail',
            feedback: `The answer doesn’t mention “${phrase}”.`,
            evidence,
            retryable: true,
          };
    },
  }));
}

/** Echo's script: it repeats the text of the last user message, unchanged. */
export function showcaseEchoGenerate(): GenerateFunction {
  return async ({ conversation }) => {
    const last = conversation.getMessages().findLast((message) => message.role === 'user');
    const text = textOf(last?.content);
    return replyResponse(text === '' ? SHOWCASE_ECHO_NOTHING_TO_REPEAT : text);
  };
}

/**
 * The three tools Tool runner holds, as the catalog lists them (`HostOptions.extraTools`): Lookup
 * order reads, Issue refund is dangerous, and Triage refunds changes things. They are the sample
 * world's built-in tools, so a screen that says what a tool may do (Capabilities, and the line
 * under a review that can't be undone) reads it from the catalog, as it would for a host's own.
 */
export function showcaseCatalogTools() {
  const lookup = createShowcaseLookupOrderTool();
  const refund = createShowcaseIssueRefundTool();
  const triage = createShowcaseTriageRefundsTool();
  return { [lookup.name]: lookup, [refund.name]: refund, [triage.name]: triage };
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

/** Workflow author's script: it says {@link SHOWCASE_WORKFLOW_AUTHOR_REPLY} to every message. */
export function showcaseWorkflowAuthorGenerate(): GenerateFunction {
  return createScriptedGenerate(repeatedReply(SHOWCASE_WORKFLOW_AUTHOR_REPLY));
}

/**
 * The scripts of the six built-in agents, by identifier, fresh, each paced by `pacing`. The agents
 * of {@link showcaseBuiltInAgents} answer from them, and so does the showcase's provider resolver
 * (`showcase.ts`) for a step of one of them that a model override sent to the provider, so a
 * built-in agent answers from its script on whatever model a person chose. One set serves both,
 * because a scripted reply keeps its position and a pace is awaited once per answer.
 */
export function showcaseAgentScripts(
  pacing: ShowcasePacing = {},
): Readonly<Record<ShowcaseAgentIdentifier, GenerateFunction>> {
  return {
    assistant: showcaseAssistantGenerate(pacing),
    echo: showcaseEchoGenerate(),
    'tool-runner': onShowcaseModel(showcaseToolRunnerGenerate(pacing)),
    'request-human-input': onShowcaseModel(showcaseHumanInputGenerate()),
    'model-switcher': showcaseModelSwitcherGenerate(),
    'workflow-author': onShowcaseModel(showcaseWorkflowAuthorGenerate()),
  };
}

/**
 * Workflow author, built from the Bureau's own tools: it holds Create workflow and Discover agents
 * ({@link SHOWCASE_WORKFLOW_AUTHOR_TOOLS}), which only the Bureau can make, so the showcase host
 * passes it as `ExtraAgents.withBureauTools`. A tool the Bureau does not offer (Create workflow
 * without a workflow directory) is left out.
 */
export function showcaseWorkflowAuthor(
  tools: BureauOwnTools,
  generate: GenerateFunction = showcaseWorkflowAuthorGenerate(),
) {
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
    generate,
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
 * own tools, and the goal checks as validators. `pacing` paces the scripts and checks (the sample
 * world's seed passes it). Each agent answers from its entry in `scripts`, which a caller that
 * answers from the same scripts elsewhere (the showcase's provider resolver) passes.
 */
export function showcaseBuiltInAgents(
  pacing: ShowcasePacing = {},
  scripts: Readonly<Record<ShowcaseAgentIdentifier, GenerateFunction>> = showcaseAgentScripts(
    pacing,
  ),
): ExtraAgents {
  return {
    agents: {
      assistant: createAgent({
        name: 'assistant',
        description: 'Answers every message with the same scripted reply.',
        examples: ['Say hello'],
        generate: scripts.assistant,
        stopWhen: stopWhen.noToolCalls(),
      }),
      'tool-runner': createAgent({
        name: 'tool-runner',
        description: 'Looks an order up, then asks for approval to refund it.',
        examples: ['Please refund order 4471, it arrived damaged.', 'Look up order 4398'],
        generate: scripts['tool-runner'],
        toolbox: createShowcaseToolRunnerToolbox(),
        stopWhen: [stopWhen.pendingApproval(), stopWhen.noToolCalls()],
      }),
      'request-human-input': createAgent({
        name: 'request-human-input',
        description: 'Asks a human which environment the release should go to.',
        examples: ['Ship the release notes fix.'],
        generate: scripts['request-human-input'],
        // The run ends on the request so it parks; once a person answers it continues to the
        // reply, which has no tool call.
        stopWhen: [stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()],
      }),
    },
    // Listed after the agents above, in this order (`SHOWCASE_AGENT_IDENTIFIERS`).
    withBureauTools: {
      'workflow-author': (tools) => showcaseWorkflowAuthor(tools, scripts['workflow-author']),
      echo: () =>
        createAgent({
          name: 'echo',
          description: 'Repeats the last message it was sent.',
          examples: ['Hello echo, say this back'],
          generate: scripts.echo,
          stopWhen: stopWhen.noToolCalls(),
        }),
      'model-switcher': () =>
        createAgent({
          name: 'model-switcher',
          description: 'Names the model it answers as, and can be switched between two.',
          examples: ['Which model are you?'],
          generate: scripts['model-switcher'],
          allowedCandidates: SHOWCASE_MODEL_SWITCHER_MODELS,
          stopWhen: stopWhen.noToolCalls(),
        }),
    },
    validators: createShowcaseValidators(pacing),
  };
}
