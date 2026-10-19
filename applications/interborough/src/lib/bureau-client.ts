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
