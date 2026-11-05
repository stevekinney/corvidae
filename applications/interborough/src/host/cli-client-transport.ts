import type { CliClientDependencies, CliCommandResult, Parsed } from './cli-client.ts';

type CliFailure = Error & { status?: number; exitCode?: 7 };
type Target = { url: string; headers: Record<string, string> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function makeCliFailure(message: string, properties: Partial<CliFailure> = {}): CliFailure {
  return Object.assign(new Error(message), properties);
}

/** Send one request with the client deadline and decode JSON-RPC failures. */
export async function request(
  target: Target,
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
    const response = await (dependencies.fetch ?? fetch)(new URL(path, `${target.url}/`), {
      ...init,
      headers,
      redirect: 'error',
      signal: controller.signal,
    });
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
