import type { FaultCode } from '@lostgradient/backchannel';
import { createCatalogClient } from '@lostgradient/backchannel/client';

import type { CatalogOperationTypes } from '@lostgradient/bureau-sdk';
import type { ClientOperationTypes } from '@lostgradient/weft';

import type { CliClientDependencies, CliCommandResult, Parsed } from './cli-client.ts';

/**
 * An error the transport raises. `faultCode`, `retryable` and `remediation` are the server's own
 * words, read from a JSON-RPC `error.data` or a REST error body; `connectionFailed` marks a request
 * that never reached a server that answered.
 */
type CliFailure = Error & {
  status?: number;
  exitCode?: number;
  /** The server's `FaultCode`, forwarded as sent. */
  faultCode?: string;
  retryable?: boolean;
  remediation?: string;
  connectionFailed?: boolean;
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Resolved management endpoint and authorization headers used by a CLI request. */
export type CliTarget = {
  /** Management endpoint without a trailing slash. */
  readonly url: string;
  /** Headers attached to every request. */
  readonly headers: Record<string, string>;
  /** Whether this target is an authenticated non-loopback management endpoint. */
  readonly remote?: boolean;
  /** Server-resolved authority for this connection. */
  readonly authority?: {
    readonly actor: string;
    readonly workspace: string;
    readonly capabilities: readonly string[];
  };
};

function makeCliFailure(message: string, properties: Partial<CliFailure> = {}): CliFailure {
  return Object.assign(new Error(message), properties);
}

/**
 * A `fetch` that rejects with a `TypeError` never reached a server that answered (a refused or reset
 * connection, a name that does not resolve): tag it, so the failure reports `CLI_CONNECTION_FAILED`.
 */
function markConnectionFailure(error: unknown): unknown {
  return error instanceof TypeError ? Object.assign(error, { connectionFailed: true }) : error;
}

function isMutation(method: string | undefined): boolean {
  return method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
}

function redactCredentials(target: CliTarget, message: string): string {
  const candidates = Object.entries(target.headers).flatMap(([name, value]) => {
    if (value === '') return [];
    const authorization =
      name.toLowerCase() === 'authorization' ? value.match(/^\S+\s+(.+)$/)?.[1] : undefined;
    return authorization === undefined ? [value] : [value, authorization];
  });
  return candidates.reduce(
    (redacted, credential) => redacted.split(credential).join('[redacted]'),
    message,
  );
}

/**
 * What a server fault says about itself, read from a JSON-RPC `error.data` or a REST error body:
 * `weftCode` is the coarse `FaultCode` only on JSON-RPC (a REST body carries the fine-grained
 * `WeftErrorCode` there), so the code is read only when `faultCodeSource` says it is one.
 */
function faultFields(
  target: CliTarget,
  source: Record<string, unknown> | undefined,
  faultCodeSource: boolean,
): Partial<CliFailure> {
  if (source === undefined) return {};
  const weftCode = source['weftCode'];
  const remediation = source['remediation'];
  return {
    ...(faultCodeSource && typeof weftCode === 'string' && weftCode !== ''
      ? { faultCode: weftCode }
      : {}),
    ...(typeof source['retryable'] === 'boolean' ? { retryable: source['retryable'] } : {}),
    ...(typeof remediation === 'string' && remediation !== ''
      ? { remediation: redactCredentials(target, remediation) }
      : {}),
  };
}

/**
 * The faults a server raises before it has done anything: it refused the call or found it
 * malformed, so nothing changed and the caller may fix the call and send it again. Every other
 * fault (`Timeout`, `Unavailable`, `EngineFailure`, `SubscriptionOverflow`) can come after the
 * change was committed, for example when a later write of the same operation fails, so a
 * mutation that fails with one has an outcome the CLI cannot know (exit 7).
 */
const FAULTS_THAT_REFUSE_BEFORE_ANY_EFFECT: ReadonlySet<string> = new Set([
  'Unauthorized',
  'Forbidden',
  'NotFound',
  'Conflict',
  'Unprocessable',
  'PayloadTooLarge',
  'NotImplemented',
  'UnsupportedTransport',
  'InvalidParams',
  'MethodNotFound',
  'StaleRevision',
  'RateLimited',
  'UnsupportedCapability',
] satisfies FaultCode[]);

/** Whether `error` is a server fault that guarantees the operation changed nothing. */
export function faultRefusedBeforeAnyEffect(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = error['faultCode'];
  return typeof code === 'string' && FAULTS_THAT_REFUSE_BEFORE_ANY_EFFECT.has(code);
}

function assertManagementBoundary(target: CliTarget, path: string): void {
  if (
    target.remote === true &&
    (path === '/jsonrpc' ||
      path.startsWith('/bureau/a2a') ||
      (path.startsWith('/bureau/assets/') && path.endsWith('/content')))
  )
    throw makeCliFailure(
      'Authenticated management credentials cannot be sent to this public route.',
      {
        exitCode: 3,
      },
    );
}

/** Send one request with the client deadline and decode JSON-RPC failures. */
export async function request(
  target: CliTarget,
  path: string,
  parsed: Parsed,
  dependencies: CliClientDependencies,
  init?: RequestInit,
): Promise<CliCommandResult> {
  assertManagementBoundary(target, path);
  // A dry run changes nothing, so a request that fails leaves no outcome unknown.
  const mutating = isMutation(init?.method) && parsed.options.get('dry-run') !== true;
  const controller = new AbortController();
  dependencies.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  // poll-reason: timer
  const timer = setTimeout(() => controller.abort(), parsed.timeout);
  try {
    const headers = new Headers(target.headers);
    if (init?.headers !== undefined) {
      for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
    }
    let response: Response;
    try {
      response = await (dependencies.fetch ?? fetch)(new URL(path, `${target.url}/`), {
        ...init,
        headers,
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      if (mutating && error instanceof DOMException && error.name === 'AbortError')
        throw makeCliFailure('The mutation outcome is unknown.', { exitCode: 7 });
      throw markConnectionFailure(error);
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      if (!response.ok)
        throw makeCliFailure(
          redactCredentials(target, text === '' ? `HTTP ${response.status}` : text),
          {
            status: response.status,
          },
        );
      throw makeCliFailure(
        'The host returned malformed JSON.',
        init?.method === 'POST' && mutating ? { exitCode: 7 } : {},
      );
    }
    if (!response.ok)
      throw makeCliFailure(
        isRecord(body) && typeof body['message'] === 'string'
          ? redactCredentials(target, body['message'])
          : `HTTP ${response.status}`,
        {
          status: response.status,
          ...faultFields(target, isRecord(body) ? body : undefined, false),
        },
      );
    if (isRecord(body) && isRecord(body['error'])) {
      const rpcError = body['error'];
      const code = typeof rpcError['code'] === 'number' ? rpcError['code'] : undefined;
      const message = redactCredentials(
        target,
        typeof rpcError['message'] === 'string' ? rpcError['message'] : 'RPC error',
      );
      const data = isRecord(rpcError['data']) ? rpcError['data'] : undefined;
      const httpStatus = typeof data?.['httpStatus'] === 'number' ? data['httpStatus'] : undefined;
      throw makeCliFailure(message, {
        ...faultFields(target, data, true),
        ...(httpStatus === undefined ? {} : { status: httpStatus }),
        ...(httpStatus === undefined && (code === -32601 || code === -32602)
          ? { status: 400 }
          : {}),
      });
    }
    return { data: body };
  } catch (error) {
    if (mutating && error instanceof DOMException && error.name === 'AbortError')
      throw makeCliFailure('The mutation outcome is unknown.', { exitCode: 7 });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Run a typed catalog operation over the CLI's authenticated management transport. */
export function catalogCall<Name extends keyof ManagedOperations>(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
  name: Name,
  input: ManagedOperations[Name]['input'],
): Promise<CliCommandResult> {
  return catalogFileCall(target, parsed, dependencies, name, input);
}

type ManagedOperations = CatalogOperationTypes & ClientOperationTypes;

type ServerValidatedOperations<Name extends keyof ManagedOperations> = {
  [Operation in Name]: {
    input: unknown;
    output: ManagedOperations[Operation]['output'];
    faults: ManagedOperations[Operation]['faults'];
  };
};

/** Send parsed JSON file input to its declared catalog operation for server-side validation. */
export async function catalogFileCall<Name extends keyof ManagedOperations>(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
  name: Name,
  input: unknown,
): Promise<CliCommandResult> {
  const client = createCatalogClient<ServerValidatedOperations<Name>>(
    [name],
    async (method, params) => {
      const response = await request(target, '/bureau/jsonrpc', parsed, dependencies, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: `cli-${crypto.randomUUID()}`, method, params }),
      });
      return isRecord(response.data) && Object.hasOwn(response.data, 'result')
        ? response.data['result']
        : response.data;
    },
  );
  return { data: await client[name](input) };
}

/** Fetch an authenticated binary response without interpreting its bytes as text. */
export async function requestBytes(
  target: CliTarget,
  path: string,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<Response> {
  assertManagementBoundary(target, path);
  const controller = new AbortController();
  dependencies.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  // poll-reason: timer
  const timer = setTimeout(() => controller.abort(), parsed.timeout);
  try {
    const response = await (dependencies.fetch ?? fetch)(new URL(path, `${target.url}/`), {
      headers: target.headers,
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      let message = `HTTP ${response.status}`;
      try {
        const parsedBody: unknown = JSON.parse(body);
        if (isRecord(parsedBody) && typeof parsedBody['message'] === 'string')
          message = redactCredentials(target, parsedBody['message']);
      } catch {
        // Keep the status when a failed binary response is not JSON.
      }
      throw makeCliFailure(message, { status: response.status });
    }
    const bytes = await response.arrayBuffer();
    return new Response(bytes, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      throw makeCliFailure('The asset download was interrupted.', { exitCode: 6 });
    throw markConnectionFailure(error);
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch an AG-UI response without buffering it, preserving the stream for incremental output. */
export async function stream(
  target: CliTarget,
  path: string,
  parsed: Parsed,
  dependencies: CliClientDependencies,
  init: RequestInit = {},
): Promise<Response> {
  assertManagementBoundary(target, path);
  const controller = new AbortController();
  dependencies.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  // poll-reason: timer
  const timer = setTimeout(() => controller.abort(), parsed.timeout);
  try {
    const headers = new Headers(target.headers);
    for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
    let response: Response;
    try {
      response = await (dependencies.fetch ?? fetch)(new URL(path, `${target.url}/`), {
        ...init,
        headers,
        keepalive: false,
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      if (init.method === 'POST' && error instanceof DOMException && error.name === 'AbortError')
        throw makeCliFailure('The mutation outcome is unknown.', { exitCode: 7 });
      throw markConnectionFailure(error);
    }
    if (!response.ok) {
      clearTimeout(timer);
      const body = await response.text();
      let message = `HTTP ${response.status}`;
      try {
        const parsedBody: unknown = JSON.parse(body);
        if (isRecord(parsedBody) && typeof parsedBody['message'] === 'string')
          message = redactCredentials(target, parsedBody['message']);
      } catch {
        // Keep the status when a failed stream does not return JSON.
      }
      throw makeCliFailure(message, { status: response.status });
    }
    if (response.body === null) {
      clearTimeout(timer);
      throw makeCliFailure('The host returned an empty event stream.');
    }
    const source = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        try {
          const next = await source.read();
          if (next.done) {
            clearTimeout(timer);
            streamController.close();
          } else streamController.enqueue(next.value);
        } catch (error) {
          clearTimeout(timer);
          streamController.error(error);
        }
      },
      async cancel(reason) {
        clearTimeout(timer);
        await source.cancel(reason);
      },
    });
    return new Response(body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}
