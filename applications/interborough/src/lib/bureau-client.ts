/**
 * The browser's door to the Bureau's management plane, `/bureau/jsonrpc` on the host's own origin
 * (`src/host/host.ts`). Weft's `HttpClient` speaks only the engine's operations, so the Bureau's
 * are called here, with the same fault vocabulary: a fault answers as an `HttpClientError`, which
 * `classifyFault` (`./faults.ts`) already treats.
 *
 * There is no sign-in. The host serves every request as the one local caller.
 */
import { HttpClientError, type FaultCode } from '@lostgradient/weft';

/** Where the host mounts the Bureau handler. */
export const BUREAU_PATH = '/bureau';

/** A session (a Bureau context), as `bureau.contexts.get` and `.list` show it. */
export type ChatContext = {
  readonly id: string;
  readonly owner: string | null;
  readonly agentName: string;
  readonly title: string | null;
  readonly lastMessagePreview: string | null;
  readonly messageCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activity: 'running' | 'awaiting-input' | 'idle';
};

/** What `bureau.contexts.input` answers for an input it admitted. */
export type ContextInputReceipt = {
  readonly outcome: 'admitted' | 'replayed';
  readonly receipt: { readonly id: string; readonly state: string };
};

type JsonRpcFault = {
  readonly message?: unknown;
  readonly data?: { readonly weftCode?: unknown; readonly httpStatus?: unknown } & Record<
    string,
    unknown
  >;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Calls one Bureau operation and returns its result, or throws the fault it answered. */
export async function callBureau<Result>(
  method: string,
  params: unknown,
  options: { readonly signal?: AbortSignal; readonly fetch?: typeof fetch } = {},
): Promise<Result> {
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
    const fault = body['error'] as JsonRpcFault;
    const data = isRecord(fault.data) ? fault.data : undefined;
    const status = typeof data?.httpStatus === 'number' ? data.httpStatus : response.status;
    throw new HttpClientError(
      status,
      typeof fault.message === 'string' ? fault.message : `HTTP ${status}`,
      {
        faultCode: typeof data?.weftCode === 'string' ? (data.weftCode as FaultCode) : undefined,
        data,
      },
    );
  }
  if (!isRecord(body) || !('result' in body)) {
    throw new HttpClientError(response.status, 'The Bureau answered with no result.');
  }
  return body['result'] as Result;
}

/** One session, with its agent and title. A session the caller cannot see is a not-found fault. */
export function getContext(
  contextId: string,
  options?: { readonly signal?: AbortSignal },
): Promise<ChatContext> {
  return callBureau<ChatContext>('bureau.contexts.get', { contextId }, options);
}

/** Sends an input to a session's run in flight (`bureau.contexts.input`, steer delivery). */
export function sendContextInput(
  contextId: string,
  input: { readonly id: string; readonly payload: unknown },
  options?: { readonly signal?: AbortSignal },
): Promise<ContextInputReceipt> {
  return callBureau<ContextInputReceipt>('bureau.contexts.input', { contextId, input }, options);
}
