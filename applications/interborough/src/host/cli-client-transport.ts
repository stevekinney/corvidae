import type { CliClientDependencies, CliCommandResult, Parsed } from './cli-client.ts';

type CliFailure = Error & { status?: number };
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
    const body: unknown = await response.json().catch(() => undefined);
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
      throw makeCliFailure(message, {
        ...(code === -32601 || code === -32602 ? { status: 400 } : {}),
        ...(code === -32001 || code === -32003 ? { status: 403 } : {}),
      });
    }
    return { data: body };
  } finally {
    clearTimeout(timer);
  }
}
