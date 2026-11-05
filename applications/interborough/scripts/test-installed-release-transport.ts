export type InstalledFetch = (...arguments_: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

export function parseRunStartedRunId(stream: string): string {
  const runId = stream.match(/"type":"RUN_STARTED"[^\n]*"runId":"([^"]+)"/)?.[1];
  if (runId === undefined) throw new Error('The AG-UI stream did not contain RUN_STARTED');
  return runId;
}

export async function mcp(
  url: string,
  id: number,
  method: string,
  params: Record<string, unknown>,
  fetcher: InstalledFetch = fetch,
): Promise<Record<string, unknown>> {
  const response = await fetcher(`${url}/bureau/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-03-26',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!response.ok) throw new Error(`MCP ${method} returned ${response.status}`);
  const text = await response.text();
  const json = text.startsWith('{') ? text : text.match(/^data: (.*)$/m)?.[1];
  if (!json) throw new Error(`MCP ${method} returned no JSON`);
  return JSON.parse(json) as Record<string, unknown>;
}

export async function runFixtureAgent(
  url: string,
  fetcher: InstalledFetch = fetch,
): Promise<{ stream: string; runId: string }> {
  const response = await fetcher(`${url}/bureau/ag-ui/agents/installed-fixture%3Aassistant/run`, {
    method: 'POST',
    headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({
      threadId: `thread-${crypto.randomUUID()}`,
      runId: `run-${crypto.randomUUID()}`,
      messages: [{ id: 'user-1', role: 'user', content: 'Greet Ada.' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  const stream = await response.text();
  if (!response.ok) throw new Error(`Fixture agent did not start: ${stream.slice(0, 500)}`);
  return { stream, runId: parseRunStartedRunId(stream) };
}
