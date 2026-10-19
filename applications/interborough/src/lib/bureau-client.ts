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
  messageCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  activity: z.enum(['running', 'awaiting-input', 'idle']),
});

export type ChatContext = z.infer<typeof chatContextSchema>;

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

/** One session, with its agent and title. A session the caller cannot see is a not-found fault. */
export async function getContext(
  contextId: string,
  options?: { readonly signal?: AbortSignal },
): Promise<ChatContext> {
  return chatContextSchema.parse(await callBureau('bureau.contexts.get', { contextId }, options));
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

/** One page of the caller's sessions, newest update first (`bureau.contexts.list`). */
export async function listContexts(
  input: { readonly agentName?: string; readonly limit?: number; readonly offset?: number } = {},
  options?: { readonly signal?: AbortSignal },
): Promise<ContextPage> {
  return contextPageSchema.parse(await callBureau('bureau.contexts.list', input, options));
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
