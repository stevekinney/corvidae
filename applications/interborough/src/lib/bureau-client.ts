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

/** The part of `fetch` the application's requests use, so a test can stand a stub in for it. */
export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Where the host mounts the Bureau handler. */
export const BUREAU_PATH = '/bureau';

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
   * What started the session: a person's `chat`, a `goal`, or a `schedule`'s fire. The Bureau
   * records it when a goal or a fire creates the session, and a session that records none is a chat,
   * which is also how an answer that names none reads here.
   */
  origin: z.enum(['chat', 'goal', 'schedule']).default('chat'),
  messageCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  activity: z.enum(['running', 'awaiting-input', 'idle']),
});

export type ChatContext = z.infer<typeof chatContextSchema>;

/**
 * One session as `bureau.contexts.get` shows it: the summary, and what its steering has settled on.
 * `model` is the latest model the session was switched to, `null` before any, which means the
 * agent's default; `configVersion` is the version a later `bureau.contexts.steer`'s
 * `expectedRevision` is compared against.
 */
export const contextDetailSchema = chatContextSchema.extend({
  model: z.object({ provider: z.string().nullable(), model: z.string() }).nullable(),
  configVersion: z.number().int().nonnegative(),
});

export type ContextDetail = z.infer<typeof contextDetailSchema>;

/** What `bureau.contexts.input` answers for an input it admitted. */
const contextInputReceiptSchema = z.object({
  outcome: z.enum(['admitted', 'replayed']),
  receipt: z.object({ id: z.string(), state: z.string() }),
});

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
    throw new HttpClientError(response.status, 'The Bureau answered with no result.');
  }
  return body['result'];
}

/** One session, with its agent, title and model. A session the caller cannot see is a not-found fault. */
export async function getContext(
  contextId: string,
  options?: { readonly signal?: AbortSignal },
): Promise<ContextDetail> {
  return contextDetailSchema.parse(await callBureau('bureau.contexts.get', { contextId }, options));
}

/** One model an agent allows, named the way a model override names it. */
const agentModelChoiceSchema = z.object({
  provider: z.string(),
  model: z.string(),
  displayName: z.string(),
});

export type AgentModelChoice = z.infer<typeof agentModelChoiceSchema>;

const agentModelsSchema = z.object({
  selectable: z.boolean(),
  models: z.array(agentModelChoiceSchema),
  /** The model the agent's next step uses with no override, or `null` when that is not known. */
  default: agentModelChoiceSchema.pick({ provider: true, model: true }).nullable(),
});

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

export type SteerOutcome = z.infer<typeof steerOutcomeSchema>;

/**
 * Switches a session to another model its agent allows (`bureau.contexts.steer`). `commandId` is
 * the caller's own identifier: an exact retry of it is a replay. `expectedRevision` is the
 * `configVersion` the caller read.
 */
export async function steerContext(
  input: {
    readonly contextId: string;
    readonly commandId: string;
    readonly override: { readonly provider: string; readonly model: string };
    readonly expectedRevision?: number;
  },
  options?: { readonly signal?: AbortSignal },
): Promise<SteerOutcome> {
  return steerOutcomeSchema.parse(await callBureau('bureau.contexts.steer', input, options));
}

/**
 * Branches a session after one of its agent's replies (`bureau.contexts.fork`) and returns the new
 * session's identifier. A refusal is a `Conflict` fault whose `data.reason` says why
 * (`forkRefusalReason`).
 */
export async function forkContext(
  input: {
    readonly contextId: string;
    readonly commandId: string;
    readonly throughMessageId: string;
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

const contextPageSchema = z.object({
  contexts: z.array(chatContextSchema),
  nextOffset: z.number().nullable(),
});

export type ContextPage = z.infer<typeof contextPageSchema>;

/**
 * One page of the caller's sessions, newest update first (`bureau.contexts.list`). `origin` keeps
 * only the sessions that were started that way, before the page is cut, so `chat` lists the
 * sessions a person started and none a goal or a schedule's fire did.
 */
export async function listContexts(
  input: {
    readonly agentName?: string;
    readonly origin?: ChatContext['origin'];
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
 * loop it.
 */
export async function listAllContexts(options?: {
  readonly signal?: AbortSignal;
}): Promise<ChatContext[]> {
  const contexts: ChatContext[] = [];
  let offset = 0;
  for (;;) {
    const page = await listContexts({ limit: CONTEXTS_PAGE_SIZE, offset }, options);
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
  publishState: z.enum(['published', 'withdrawn', 'unpublished']),
  /** `null` for an agent that names no model, which can take no attachment. */
  media: agentMediaSchema.nullable().default(null),
});

export type AgentSummary = z.infer<typeof agentSummarySchema>;

/** The agents the caller may see, with whether each is published (`bureau.agents.list`). */
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
