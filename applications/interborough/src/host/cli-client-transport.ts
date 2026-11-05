import type { CliClientDependencies, CliCommandResult, Parsed } from './cli-client.ts';

type CliFailure = Error & { status?: number; exitCode?: 7 };
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Resolved management endpoint and authorization headers used by a CLI request. */
export type CliTarget = {
  /** Management endpoint without a trailing slash. */
  readonly url: string;
  /** Headers attached to every request. */
  readonly headers: Record<string, string>;
};

function makeCliFailure(message: string, properties: Partial<CliFailure> = {}): CliFailure {
  return Object.assign(new Error(message), properties);
}

/** Send one request with the client deadline and decode JSON-RPC failures. */
export async function request(
  target: CliTarget,
  path: string,
  parsed: Parsed,
  dependencies: CliClientDependencies,
  init?: RequestInit,
): Promise<CliCommandResult> {
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
      if (init?.method === 'POST' && error instanceof DOMException && error.name === 'AbortError')
        throw makeCliFailure('The mutation outcome is unknown.', { exitCode: 7 });
      throw error;
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      throw makeCliFailure(
        'The host returned malformed JSON.',
        init?.method === 'POST' ? { exitCode: 7 } : {},
      );
    }
    if (!response.ok)
      throw makeCliFailure(
        isRecord(body) && typeof body['message'] === 'string'
          ? body['message']
          : `HTTP ${response.status}`,
        { status: response.status },
      );
    if (isRecord(body) && isRecord(body['error'])) {
      const rpcError = body['error'];
      const code = typeof rpcError['code'] === 'number' ? rpcError['code'] : undefined;
      const message = typeof rpcError['message'] === 'string' ? rpcError['message'] : 'RPC error';
      const data = isRecord(rpcError['data']) ? rpcError['data'] : undefined;
      const httpStatus = typeof data?.['httpStatus'] === 'number' ? data['httpStatus'] : undefined;
      throw makeCliFailure(message, {
        ...(httpStatus === undefined ? {} : { status: httpStatus }),
        ...(httpStatus === undefined && (code === -32601 || code === -32602)
          ? { status: 400 }
          : {}),
      });
    }
    return { data: body };
  } catch (error) {
    if (init?.method === 'POST' && error instanceof DOMException && error.name === 'AbortError')
      throw makeCliFailure('The mutation outcome is unknown.', { exitCode: 7 });
    throw error;
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
      throw error;
    }
    if (!response.ok) {
      clearTimeout(timer);
      const body = await response.text();
      let message = `HTTP ${response.status}`;
      try {
        const parsedBody: unknown = JSON.parse(body);
        if (isRecord(parsedBody) && typeof parsedBody['message'] === 'string')
          message = parsedBody['message'];
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
        const next = await source.read();
        if (next.done) {
          clearTimeout(timer);
          streamController.close();
        } else streamController.enqueue(next.value);
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
