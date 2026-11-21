/**
 * The transport of the generated Bureau client (`./generated/`): it posts JSON-RPC to the host's
 * own origin, asks the write guard first, and answers a fault as the `HttpClientError` the
 * console's treatments read (`classifyFault`, `./faults.ts`). There is no sign-in: the host serves
 * every request as the one local caller.
 */
import type {
  CatalogCallOptions,
  CatalogFetch,
  CatalogTransport,
} from '@lostgradient/backchannel/client';
import { jsonRpcHttpEndpoint } from '@lostgradient/backchannel/client';
import { HttpClientError } from '@lostgradient/weft';

import { faultAdviceOf } from './faults.ts';
import { refuseWrite } from './write-guard.ts';

/**
 * Where the generated Bureau client sends its calls. `baseUrl` is the host's root, so calls go to
 * the composed `/jsonrpc` endpoint and subscriptions to the route prefix the client names;
 * `headers` go on every call; `fetch` stands in for the global one unless a call brings its own.
 */
export type BureauClientConnection = {
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly fetch?: CatalogFetch | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Posts one JSON-RPC call to `endpoint` and returns its result, or throws the fault it answered as
 * an `HttpClientError` with the fault's `httpStatus`, message, data, and the `retryable` and
 * `remediation` its `data` carries. A write is refused first,
 * by operation, before any `fetch` is chosen: see `./write-guard.ts`.
 */
export async function postBureauCall(
  endpoint: string,
  method: string,
  params: unknown,
  options: CatalogCallOptions & { readonly headers?: Readonly<Record<string, string>> | undefined },
): Promise<unknown> {
  refuseWrite(method);
  // The global is read at the call, so a test or the write guard can replace it after the client exists.
  const send = options.fetch ?? globalThis.fetch;
  const response = await send(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
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
      { data, ...faultAdviceOf(data) },
    );
  }
  if (!isRecord(body) || !('result' in body)) {
    throw new HttpClientError(response.status, 'The server answered with no result.');
  }
  return body['result'];
}

/** The transport the generated client is built on: `postBureauCall` to the connection's `/jsonrpc`. */
export function bureauTransport(connection: BureauClientConnection): CatalogTransport {
  const endpoint = jsonRpcHttpEndpoint(connection.baseUrl);
  return (operationName, input, options) =>
    postBureauCall(endpoint, operationName, input, {
      headers: connection.headers,
      fetch: options?.fetch ?? connection.fetch,
      signal: options?.signal,
    });
}
