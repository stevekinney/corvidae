export type InstalledFetch = (...arguments_: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

export function parseRunStartedRunId(stream: string): string {
  const events = stream
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>);
  const failure = events.find((event) => event['type'] === 'RUN_ERROR');
  if (failure !== undefined) throw new Error(`Fixture run failed: ${JSON.stringify(failure)}`);
  const started = events.find((event) => event['type'] === 'RUN_STARTED');
  const metadata = started?.['metadata'] as Record<string, Record<string, unknown>> | undefined;
  const runId = metadata?.['@lostgradient/bureau']?.['runId'];
  if (typeof runId !== 'string' || runId.length === 0)
    throw new Error(
      'The AG-UI stream did not contain RUN_STARTED with a native Bureau run identifier',
    );
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
