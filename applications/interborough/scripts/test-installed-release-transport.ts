import type { Subprocess } from 'bun';

export type InstalledFetch = (...arguments_: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

/** Interrupt only after visible readiness, and collect the child even when the stream fails. */
export async function interruptInstalledStream(
  child: Pick<
    Subprocess<'ignore', 'pipe', 'pipe'>,
    'stdout' | 'stderr' | 'kill' | 'exited' | 'exitCode'
  >,
  beforeState: string,
  readState: () => Promise<{ exitCode: number; stdout: string }>,
): Promise<{ exitCode: number }> {
  const reader = child.stdout.getReader();
  const stderr = new Response(child.stderr).text();
  const decoder = new TextDecoder();
  let stdout = '';
  try {
    while (!stdout.includes('ready\n')) {
      const next = await reader.read();
      if (next.done) throw new Error(`Compiled SIGINT stream never reached readiness: ${stdout}`);
      stdout += decoder.decode(next.value, { stream: true });
    }
    child.kill('SIGINT');
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      stdout += decoder.decode(next.value, { stream: true });
    }
    const [errors, exitCode] = await Promise.all([stderr, child.exited]);
    if (exitCode !== 130) throw new Error(`Compiled SIGINT stream exited ${exitCode}: ${errors}`);
    const afterState = await readState();
    if (afterState.exitCode !== 0 || beforeState !== afterState.stdout)
      throw new Error('SIGINT stream changed durable mutation state');
    return { exitCode };
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    reader.releaseLock();
    await Promise.all([stderr, child.exited]);
  }
}

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

/** Execute approval through its returned continuation, rejecting incomplete command results. */
export async function verifyInstalledApproval(
  runCommand: (
    arguments_: string[],
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): Promise<{ reviewId: string; runId: string }> {
  const approvalChat = await runCommand([
    'chat',
    '--agent',
    'demo:tool-runner',
    '--message',
    'Refund order-1001',
    '--no-input',
  ]);
  if (approvalChat.exitCode !== 5)
    throw new Error(`Approval chat did not pause: ${approvalChat.exitCode} ${approvalChat.stderr}`);
  const runId = `${approvalChat.stdout}\n${approvalChat.stderr}`.match(/run-[A-Za-z0-9_-]+/)?.[0];
  if (runId === undefined) throw new Error('Approval chat did not report a run identifier');
  const reviews = await runCommand(['reviews', 'list', '--output', 'json']);
  if (reviews.exitCode !== 0) throw new Error(`Review list failed: ${reviews.stderr}`);
  const reviewPayload = JSON.parse(reviews.stdout) as {
    data?: { reviews?: Array<{ id?: string }> };
  };
  const reviewId = reviewPayload.data?.reviews?.[0]?.id;
  if (reviewId === undefined) throw new Error('Approval chat did not create a review');
  const approved = await runCommand(['reviews', 'approve', reviewId]);
  if (approved.exitCode !== 0) throw new Error(`Review approval failed: ${approved.stderr}`);
  const continuationRunId = (
    JSON.parse(approved.stdout) as {
      continuation?: { runId?: unknown };
    }
  ).continuation?.runId;
  if (typeof continuationRunId !== 'string')
    throw new Error('Review approval did not return a continuation run identifier');
  const result = await runCommand([
    'runs',
    'watch',
    '--kind',
    'task',
    continuationRunId,
    '--output',
    'jsonl',
  ]);
  if (result.exitCode !== 0 || !result.stdout.includes('completed'))
    throw new Error(`Approved result did not complete: ${result.exitCode} ${result.stderr}`);

  return { reviewId, runId };
}

/** Reject stale writes and verify their public readback remains unchanged. */
export async function verifyStaleInstalledWorkflow(
  runCommand: (
    arguments_: string[],
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  workflowUpdateFile: string,
): Promise<{ currentHash: string; staleExit: number }> {
  const beforeStaleWorkflow = await runCommand([
    'workflows',
    'get',
    'installed-cli-workflow',
    '--output',
    'json',
  ]);
  if (beforeStaleWorkflow.exitCode !== 0)
    throw new Error(`Could not read workflow before stale probe: ${beforeStaleWorkflow.stderr}`);
  const beforeStaleWorkflowData = JSON.parse(beforeStaleWorkflow.stdout) as {
    data?: { hash?: string; [key: string]: unknown };
  };
  if (typeof beforeStaleWorkflowData.data?.hash !== 'string')
    throw new Error('Workflow read did not return a current hash');
  const stale = await runCommand([
    'workflows',
    'update',
    'installed-cli-workflow',
    '--file',
    workflowUpdateFile,
    '--if-revision',
    '0000000000000000000000000000000000000000000000000000000000000000',
  ]);
  if (stale.exitCode !== 4)
    throw new Error(`Stale installed mutation was not rejected: ${stale.exitCode} ${stale.stderr}`);
  const afterStaleWorkflow = await runCommand([
    'workflows',
    'get',
    'installed-cli-workflow',
    '--output',
    'json',
  ]);
  if (afterStaleWorkflow.exitCode !== 0 || afterStaleWorkflow.stdout !== beforeStaleWorkflow.stdout)
    throw new Error('Stale installed mutation changed durable workflow state');

  return { currentHash: beforeStaleWorkflowData.data.hash, staleExit: stale.exitCode };
}

/** Forward requests, but drop an agent-create response only after consuming its committed response. */
export function createResponseDroppingProxy(upstream: URL) {
  const droppedMutationRequests: string[] = [];
  let droppedUpstreamStatus: number | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const target = new URL(request.url);
      target.protocol = upstream.protocol;
      target.hostname = upstream.hostname;
      target.port = upstream.port;
      const body =
        request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : await request.arrayBuffer();
      const headers = new Headers(request.headers);
      headers.set('host', target.host);
      const forwarded = await fetch(target, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
      if (target.pathname === '/bureau/jsonrpc' && request.method === 'POST') {
        const forwardedBody = body === undefined ? '' : new TextDecoder().decode(body);
        if (forwardedBody.includes('bureau.agents.definitions.create')) {
          droppedMutationRequests.push(forwardedBody);
          droppedUpstreamStatus = forwarded.status;
          await forwarded.text();
          const stream = new TransformStream<Uint8Array, Uint8Array>();
          void stream.writable.abort(new Error('downstream response dropped'));
          return new Response(stream.readable);
        }
      }
      return new Response(forwarded.body, {
        status: forwarded.status,
        headers: forwarded.headers,
      });
    },
  });

  return {
    server,
    requests: droppedMutationRequests,
    get upstreamStatus() {
      return droppedUpstreamStatus;
    },
  };
}
