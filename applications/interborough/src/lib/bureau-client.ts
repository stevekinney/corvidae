/**
 * The browser's door to the Bureau's management plane, `/bureau/jsonrpc` on the host's own origin
 * (`src/host/host.ts`). Weft's `HttpClient` speaks only the engine's operations, so the Bureau's
 * are called here, with the same fault vocabulary: a fault answers as an `HttpClientError`, which
 * `classifyFault` (`./faults.ts`) already treats.
 *
 * There is no sign-in. The host serves every request as the one local caller.
 */
import { HttpClientError } from '@lostgradient/weft';
import { z } from 'zod';

import { refuseWrite } from './write-guard.ts';

/** The part of `fetch` the application's requests use, so a test can stand a stub in for it. */
export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Where the host mounts the Bureau handler. */
export const BUREAU_PATH = '/bureau';

/** The origins the Bureau can be asked to filter sessions by. */
export type ContextOrigin = 'chat' | 'goal' | 'schedule';

/**
 * Every origin a session can report: those a list can be filtered by in the chat views, and `try`,
 * a throwaway chat with an unsaved agent definition (`bureau.agents.try`), which the Bureau leaves
 * out of the list unless it is asked for.
 */
export type ReportedOrigin = ContextOrigin | 'try';

/** A session (a Bureau context), as `bureau.contexts.get` and `.list` show it. */
export const chatContextSchema = z.object({
  id: z.string(),
  owner: z.string().nullable(),
  agentName: z.string(),
  title: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
  /** The session this one was branched from (`bureau.contexts.fork`), or `null`. */
  parentContextId: z.string().nullable(),
  /** The message of the parent this one was branched at, or `null`. */
  forkedFromMessageId: z.string().nullable(),
  /**
   * What started the session: a person's `chat`, a `goal`, a `schedule`'s fire, or `try`, a
   * throwaway chat with an agent definition that is not saved (`bureau.agents.try`), which the list
   * leaves out unless it is asked for. The Bureau
   * records it when a goal or a fire creates the session, and a session that records none is a chat,
   * which is also how an answer that names none reads here. A value this client does not know (a
   * Bureau newer than the browser) reads `other`: the session is kept, and since only a `chat`
   * is shown in Chat, it is not one.
   */
  origin: z
    .enum(['chat', 'goal', 'schedule', 'try'])
    .or(z.unknown().transform((): 'other' => 'other'))
    .default('chat'),
  messageCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  activity: z.enum(['running', 'awaiting-input', 'idle']),
});

/**
 * One session as the session list shows it: its agent, title, preview, origin, activity, and
 * counts and timestamps.
 */
export type ChatContext = z.infer<typeof chatContextSchema>;

/** The reasoning efforts a session can be set to (`bureau.contexts.steer`'s `effort`). */
const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

/** A reasoning effort, as `bureau.contexts.steer` takes it and `bureau.contexts.get` reports it. */
export type Effort = z.infer<typeof effortSchema>;

/** The permission modes a session can be set to (`bureau.contexts.steer`'s `permissionMode`). */
const permissionModeSchema = z.enum(['always', 'on-changes', 'allow-all', 'read-only']);

/**
 * How readily a session's tool calls ask a person, as `bureau.contexts.steer` takes it and
 * `bureau.contexts.get` reports it: `on-changes` asks as each tool's own setting says (the default),
 * `always` asks on every call, `allow-all` skips the asks `on-changes` would raise, and `read-only`
 * denies every tool that is not read-only. It governs every tool of the chat's runs, whichever
 * kind of agent holds it; only `requestHumanInput`, which just asks a person, stands outside it.
 */
export type PermissionMode = z.infer<typeof permissionModeSchema>;

/**
 * One session as `bureau.contexts.get` shows it: the summary, and what its steering has settled on.
 * `model` is the latest model the session was switched to, `null` before any, which means the
 * agent's default; `effort` is the latest effort it was set to, `null` before any; `permissionMode`
 * is its permission mode, `on-changes` before one was set; `configVersion` is
 * the version a later `bureau.contexts.steer`'s `expectedRevision` is compared against.
 */
export const contextDetailSchema = chatContextSchema.extend({
  model: z.object({ provider: z.string().nullable(), model: z.string() }).nullable(),
  effort: effortSchema.nullable(),
  permissionMode: permissionModeSchema,
  configVersion: z.number().int().nonnegative(),
});

/**
 * One session with its agent, title, and the model and configuration version its steering has
 * settled on.
 */
export type ContextDetail = z.infer<typeof contextDetailSchema>;

/** What `bureau.contexts.input` answers for an input it admitted. */
const contextInputReceiptSchema = z.object({
  outcome: z.enum(['admitted', 'replayed']),
  receipt: z.object({ id: z.string(), state: z.string() }),
});

/**
 * What the Bureau answers for an input it admitted: whether it was admitted or replayed, and the
 * receipt's identifier and state.
 */
export type ContextInputReceipt = z.infer<typeof contextInputReceiptSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Calls one Bureau operation and returns its result, or throws the fault it answered. */
export async function callBureau(
  method: string,
  params: unknown,
  options: { readonly signal?: AbortSignal; readonly fetch?: Fetcher } = {},
): Promise<unknown> {
  // A write is refused here, by operation, before any fetch is chosen: see `./write-guard.ts`.
  refuseWrite(method);
  const send = options.fetch ?? fetch;
  const response = await send(`${BUREAU_PATH}/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new HttpClientError(response.status, response.statusText || `HTTP ${response.status}`);
  }
  if (isRecord(body) && isRecord(body['error'])) {
    const fault = body['error'];
    const data = isRecord(fault['data']) ? fault['data'] : undefined;
    const status = typeof data?.['httpStatus'] === 'number' ? data['httpStatus'] : response.status;
    // The status says what kind of fault it is, which is all the console's treatments read.
    throw new HttpClientError(
      status,
      typeof fault['message'] === 'string' ? fault['message'] : `HTTP ${status}`,
      { data },
    );
  }
  if (!isRecord(body) || !('result' in body)) {
    throw new HttpClientError(response.status, 'The server answered with no result.');
  }
  return body['result'];
}

const deploymentIdSchema = z.object({ id: z.string().min(1) });

/**
 * The Bureau's own identifier (`bureau.deployment.get`), which `bureau.events` names as its
 * `bureauId`. The feed is addressed by it and answers `NotFound` for any other.
 */
export async function getBureauId(options?: { readonly signal?: AbortSignal }): Promise<string> {
  return deploymentIdSchema.parse(await callBureau('bureau.deployment.get', {}, options)).id;
}

/** One session, with its agent, title and model. A session the caller cannot see is a not-found fault. */
export async function getContext(
  contextId: string,
  options?: { readonly signal?: AbortSignal },
): Promise<ContextDetail> {
  return contextDetailSchema.parse(await callBureau('bureau.contexts.get', { contextId }, options));
}

/** What fills a context's window, as `bureau.contexts.window` names the categories, in its order. */
export const WINDOW_CATEGORIES = ['system', 'tools', 'messages', 'memory', 'attachments'] as const;

/** One thing that fills a context's window. */
export type WindowCategoryName = (typeof WINDOW_CATEGORIES)[number];

const contextWindowSchema = z.object({
  maxTokens: z.number().int().nonnegative().nullable(),
  usedEstimated: z.number().int().nonnegative(),
  usedReported: z.number().int().nonnegative().nullable(),
  categories: z.array(
    z.object({ name: z.enum(WINDOW_CATEGORIES), tokens: z.number().int().nonnegative() }),
  ),
});

/**
 * How full a context's window is (`bureau.contexts.window`): `maxTokens` is the window of the model
 * that would answer, `null` when it is not known; `usedEstimated` is the estimated size of the next
 * prompt and always the sum of `categories`; `usedReported` is the provider's own count for the
 * latest step, `null` when there is none. It holds counts only.
 */
export type ContextWindow = z.infer<typeof contextWindowSchema>;

/** How full one session's window is, and what fills it (`bureau.contexts.window`). */
export async function getContextWindow(
  contextId: string,
  options?: { readonly signal?: AbortSignal },
): Promise<ContextWindow> {
  return contextWindowSchema.parse(
    await callBureau('bureau.contexts.window', { contextId }, options),
  );
}

/** One model an agent allows, named the way a model override names it. */
const agentModelChoiceSchema = z.object({
  provider: z.string(),
  model: z.string(),
  displayName: z.string(),
  /** Present when the agent has a cost budget and the catalog has no price for the model, so a switch to it is refused. */
  unpriced: z.literal(true).optional(),
});

/**
 * One model an agent allows a session to be switched to: its provider, model name, and display
 * name; `unpriced` when the agent's cost budget cannot count the model.
 */
export type AgentModelChoice = z.infer<typeof agentModelChoiceSchema>;

const agentModelsSchema = z.object({
  selectable: z.boolean(),
  models: z.array(agentModelChoiceSchema),
  /** The model the agent's next step uses with no override, or `null` when that is not known. */
  default: agentModelChoiceSchema.pick({ provider: true, model: true }).nullable(),
});

/**
 * The models a session of an agent may be switched to, whether the agent allows a choice at all,
 * and the model used with no override.
 */
export type AgentModels = z.infer<typeof agentModelsSchema>;

/** The models a session of an agent may be switched to (`bureau.agents.models`). */
export async function getAgentModels(
  agentName: string,
  options?: { readonly signal?: AbortSignal },
): Promise<AgentModels> {
  return agentModelsSchema.parse(await callBureau('bureau.agents.models', { agentName }, options));
}

/**
 * What `bureau.contexts.steer` answers: Bureau's admission outcome, as data. A refusal is an
 * outcome and not a fault; only a missing session or a malformed request is a fault. The reasons
 * are read as the Bureau names them (`model-not-allowed`, `stale-revision`, and so on).
 */
const steerOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('accepted') }),
  z.object({ outcome: z.literal('replayed') }),
  z.object({ outcome: z.literal('conflict') }),
  z.object({ outcome: z.literal('rejected'), failure: z.object({ reason: z.string() }) }),
  z.object({ outcome: z.literal('session-terminal') }),
  z.object({ outcome: z.literal('unsupported-capability'), reason: z.string() }),
]);

/**
 * How the Bureau answered a request to switch a session's model: accepted, replayed, conflicting,
 * rejected with a reason, or refused because the session ended or cannot be steered.
 */
export type SteerOutcome = z.infer<typeof steerOutcomeSchema>;

/**
 * Changes one setting of a session (`bureau.contexts.steer`): `override` switches it to another
 * model its agent allows, `effort` sets its reasoning effort, `permissionMode` sets how readily its
 * tool calls ask a person, and a request carries exactly one.
 * `commandId` is the caller's own identifier: an exact retry of it is a replay. `expectedRevision`
 * is the `configVersion` the caller read.
 */
export async function steerContext(
  input: {
    readonly contextId: string;
    readonly commandId: string;
    readonly expectedRevision?: number;
  } & (
    | {
        readonly override: { readonly provider: string; readonly model: string };
        readonly effort?: never;
        readonly permissionMode?: never;
      }
    | {
        readonly effort: Effort;
        readonly override?: never;
        readonly permissionMode?: never;
      }
    | {
        readonly permissionMode: PermissionMode;
        readonly override?: never;
        readonly effort?: never;
      }
  ),
  options?: { readonly signal?: AbortSignal },
): Promise<SteerOutcome> {
  return steerOutcomeSchema.parse(await callBureau('bureau.contexts.steer', input, options));
}

/**
 * Branches a session after one of its agent's replies, or before its first message when
 * `throughMessageId` is `null` (`bureau.contexts.fork`), and returns the new session's identifier. A refusal is a `Conflict` fault whose `data.reason` says why
 * (`forkRefusalReason`).
 */
export async function forkContext(
  input: {
    readonly contextId: string;
    readonly commandId: string;
    readonly throughMessageId: string | null;
  },
  options?: { readonly signal?: AbortSignal },
): Promise<string> {
  return z
    .object({ contextId: z.string() })
    .parse(await callBureau('bureau.contexts.fork', input, options)).contextId;
}

/** Why a branch was refused: the `data.reason` of the fault, or `undefined` for any other fault. */
export function forkRefusalReason(error: unknown): string | undefined {
  if (!(error instanceof HttpClientError)) return undefined;
  const reason = error.data?.['reason'];
  return typeof reason === 'string' ? reason : undefined;
}

/**
 * Why `bureau.contexts.steer` refused a request with an `InvalidParams` fault, in the Bureau's own
 * words (the message of the first issue it names, such as an agent whose cost budget cannot count
 * the model), or `undefined` for any other fault or a failure that was not a fault.
 */
export function steerRefusalReason(error: unknown): string | undefined {
  if (!(error instanceof HttpClientError) || error.data?.['weftCode'] !== 'InvalidParams') {
    return undefined;
  }
  const issues = error.data['issues'];
  if (!Array.isArray(issues)) return undefined;
  const first: unknown = issues[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const message = (first as { message?: unknown }).message;
  return typeof message === 'string' && message !== '' ? message : undefined;
}

/** Sends an input to a session's run in flight (`bureau.contexts.input`, steer delivery). */
export async function sendContextInput(
  contextId: string,
  input: { readonly id: string; readonly payload: unknown },
  options?: { readonly signal?: AbortSignal },
): Promise<ContextInputReceipt> {
  return contextInputReceiptSchema.parse(
    await callBureau('bureau.contexts.input', { contextId, input }, options),
  );
}

/**
 * Gives a session a title of the caller's choosing (`bureau.contexts.rename`), or takes the one it
 * was given away with `null`, which shows the title derived from its first message again. The
 * Bureau trims the title and refuses a blank one or one over 200 characters as `InvalidParams`.
 * Setting the title a session already has is not an error, so a retry is safe. The answer is a
 * receipt: the title now stored (`null` once removed), not the session.
 */
export async function renameContext(
  input: { readonly contextId: string; readonly title: string | null },
  options?: { readonly signal?: AbortSignal },
): Promise<string | null> {
  return z
    .object({ contextId: z.string(), title: z.string().nullable() })
    .parse(await callBureau('bureau.contexts.rename', input, options)).title;
}

/**
 * What `bureau.contexts.delete` settled for the runs the session had going: `applied` (none),
 * `cleaned-up`, or a cleanup still going or unfinished, and `rejected` when the Bureau was shutting
 * down and deleted nothing.
 */
export const contextDeleteReceiptSchema = z.enum([
  'applied',
  'rejected',
  'cleanup-pending',
  'cleaned-up',
  'cleanup-failed',
  'cleanup-unresolved',
  'unknown-outcome',
]);

/** What {@link deleteContext} answers: the receipt for the session's live runs. */
export type ContextDeleteReceipt = z.infer<typeof contextDeleteReceiptSchema>;

/**
 * Deletes a session and its content, cancelling the runs it has going (`bureau.contexts.delete`).
 * A session that is already gone is a not-found fault. The receipt says whether the runs it
 * cancelled were cleaned up; `rejected` means a Bureau that was shutting down applied nothing.
 */
export async function deleteContext(
  contextId: string,
  options?: { readonly signal?: AbortSignal; readonly fetch?: Fetcher },
): Promise<ContextDeleteReceipt> {
  return z
    .object({ contextId: z.string(), receipt: contextDeleteReceiptSchema })
    .parse(await callBureau('bureau.contexts.delete', { contextId }, options)).receipt;
}

const contextPageSchema = z.object({
  contexts: z.array(chatContextSchema),
  nextOffset: z.number().nullable(),
});

/** One page of sessions and the offset of the next page, or `null` on the last. */
export type ContextPage = z.infer<typeof contextPageSchema>;

/**
 * One page of the caller's sessions, newest update first (`bureau.contexts.list`). `origin` keeps
 * only the sessions that were started that way, before the page is cut, so `chat` lists the
 * sessions a person started and none a goal or a schedule's fire did.
 */
export async function listContexts(
  input: {
    readonly agentName?: string;
    readonly origin?: ReportedOrigin;
    /** Only the chats whose title contains this text, ignoring case, before the page is cut. */
    readonly titleContains?: string;
    /** Only the chats in this activity state right now, before the page is cut. */
    readonly activity?: 'running' | 'awaiting-input';
    readonly sortBy?: 'updatedAt' | 'createdAt';
    readonly sortOrder?: 'asc' | 'desc';
    readonly limit?: number;
    readonly offset?: number;
  } = {},
  options?: { readonly signal?: AbortSignal },
): Promise<ContextPage> {
  return contextPageSchema.parse(await callBureau('bureau.contexts.list', input, options));
}

/** How many sessions one request of {@link listAllContexts} asks for. */
const CONTEXTS_PAGE_SIZE = 100;

/**
 * Every session the caller owns: pages are read, `nextOffset` followed, until the Bureau has no
 * more. An offset that does not move forward ends the read, so a Bureau that repeats itself cannot
 * loop it. `origin` is passed to the Bureau on every page, so it filters before a page is cut.
 */
export async function listAllContexts(options?: {
  readonly signal?: AbortSignal;
  readonly origin?: ContextOrigin;
}): Promise<ChatContext[]> {
  const contexts: ChatContext[] = [];
  const { origin, ...requestOptions } = options ?? {};
  let offset = 0;
  for (;;) {
    const page = await listContexts(
      { limit: CONTEXTS_PAGE_SIZE, offset, ...(origin === undefined ? {} : { origin }) },
      requestOptions,
    );
    contexts.push(...page.contexts);
    if (page.nextOffset === null || page.nextOffset <= offset) return contexts;
    offset = page.nextOffset;
  }
}

/** What an agent's model takes in the way of media (`bureau.agents.list`'s `media`). */
export const agentMediaSchema = z.object({
  modalities: z.record(z.string(), z.object({ input: z.boolean(), output: z.boolean() })),
  mimeFamilies: z.array(z.string()),
  mediaLimits: z.array(
    z.object({ modality: z.string(), maxBytes: z.number().int().nonnegative() }),
  ),
});

/** An agent as `bureau.agents.list` shows it. */
export const agentSummarySchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  definitionRevision: z.number(),
  kind: z.enum(['code', 'file']),
  /** Whether the agent opts into A2A. Every listed agent can take a chat whatever this says. */
  a2a: z.boolean(),
  /** `null` for an agent that names no model, which can take no attachment. */
  media: agentMediaSchema.nullable().default(null),
  /**
   * The names of the agent's tools. Absent when the Bureau does not say, which is not the same as
   * `[]`, an agent it says has none.
   */
  tools: z.array(z.string()).optional(),
  /**
   * Prompts that show what a person might ask the agent, which a new chat offers as buttons.
   * Absent when the agent has none.
   */
  examples: z.array(z.string()).optional(),
});

/**
 * An agent as the agent list shows it: its name, description, kind, A2A opt-in, attachment
 * support, tools, and example prompts.
 */
export type AgentSummary = z.infer<typeof agentSummarySchema>;

/** The agents the Bureau lists, each of which can take a chat (`bureau.agents.list`). */
export async function listAgents(options?: {
  readonly signal?: AbortSignal;
}): Promise<readonly AgentSummary[]> {
  const body = z
    .object({ agents: z.array(agentSummarySchema) })
    .parse(await callBureau('bureau.agents.list', {}, options));
  return body.agents;
}

const threadMessagesSchema = z.object({ threadId: z.string(), messages: z.array(z.unknown()) });

/** A thread's conversation as AG-UI messages (`GET /bureau/ag-ui/threads/<id>/messages`), or a not-found fault. */
export async function getThreadMessages(
  threadId: string,
  options: { readonly signal?: AbortSignal; readonly fetch?: Fetcher } = {},
): Promise<readonly unknown[]> {
  const send = options.fetch ?? fetch;
  const response = await send(
    `${BUREAU_PATH}/ag-ui/threads/${encodeURIComponent(threadId)}/messages`,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  if (!response.ok) {
    throw new HttpClientError(response.status, `The thread answered ${response.status}.`);
  }
  return threadMessagesSchema.parse(await response.json()).messages;
}

/**
 * The wire fault code a Bureau answer carried (`NotFound`, `Unprocessable`, and so on), or
 * `undefined` for an error that did not come from the Bureau. The status says only what kind of fault
 * it was; the code says which.
 */
export function wireCodeOf(error: unknown): string | undefined {
  if (!(error instanceof HttpClientError)) return undefined;
  const code = error.data?.['weftCode'];
  return typeof code === 'string' ? code : undefined;
}
