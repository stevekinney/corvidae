import { request, stream, type CliTarget } from './cli-client-transport.ts';
import type { CliClientDependencies, CliCommandResult, Parsed } from './cli-client.ts';

type RecordValue = Record<string, unknown>;
type RunKind = 'task' | 'workflow';

function record(value: unknown): RecordValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function option(parsed: Parsed, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === 'string' ? value : undefined;
}

function numberOption(parsed: Parsed, name: string): number | undefined {
  const value = option(parsed, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0)
    throw Object.assign(new Error(`Option --${name} must be a nonnegative integer.`), {
      usage: true,
    });
  return number;
}

function requiredKind(parsed: Parsed): RunKind {
  const kind = option(parsed, 'kind');
  if (kind !== 'task' && kind !== 'workflow')
    throw Object.assign(new Error('runs operations require --kind task|workflow.'), {
      usage: true,
    });
  return kind;
}

function identifier(parsed: Parsed): string {
  const value = parsed.arguments[1] ?? option(parsed, 'task-id');
  if (value === undefined || value === '')
    throw Object.assign(new Error('runs operations require an execution identifier.'), {
      usage: true,
    });
  return value.replace(/^(task|workflow):/, '');
}

function qualified(kind: RunKind, id: string): string {
  return `${kind}:${id}`;
}

async function rpc(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
  method: string,
  params: RecordValue,
): Promise<CliCommandResult> {
  const response = await request(target, '/bureau/jsonrpc', parsed, dependencies, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `cli-${crypto.randomUUID()}`, method, params }),
  });
  const body = record(response.data);
  return body !== undefined && Object.hasOwn(body, 'result')
    ? { ...response, data: body['result'] }
    : response;
}

function withIdentifier(kind: RunKind, value: unknown, fallback: string): RecordValue {
  const data = record(value) ?? {};
  const raw = typeof data['id'] === 'string' ? data['id'] : fallback;
  return { ...data, kind, id: qualified(kind, raw), rawId: raw };
}

function parseSse(buffer: string): {
  frames: Array<{ id?: string; event?: string; data?: unknown }>;
  rest: string;
} {
  const sections = buffer.split(/\r?\n\r?\n/);
  const rest = sections.pop() ?? '';
  const frames: Array<{ id?: string; event?: string; data?: unknown }> = [];
  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    const id = lines
      .find((line) => line.startsWith('id:'))
      ?.slice(3)
      .trim();
    const event = lines
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim();
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    const metadata = {
      ...(id === undefined ? {} : { id }),
      ...(event === undefined ? {} : { event }),
    };
    if (data === '' || data === '[DONE]') frames.push(metadata);
    else {
      try {
        frames.push({ ...metadata, data: JSON.parse(data) });
      } catch {
        // Ignore comments and malformed keep-alive frames.
      }
    }
  }
  return { frames, rest };
}

function taskPath(taskId: string, cursor: string | undefined): string {
  const query = new URLSearchParams({ taskId });
  if (cursor !== undefined) query.set('fromCursor', cursor);
  return `/v1/subscriptions/bureau.tasks.events?${query}`;
}

function workflowPath(workflowId: string, cursor: string | undefined): string {
  const query = cursor === undefined ? '' : `?fromCursor=${encodeURIComponent(cursor)}`;
  return `/v1/workflows/${encodeURIComponent(workflowId)}/events/sse${query}`;
}

function terminal(kind: RunKind, event: RecordValue): boolean {
  if (kind === 'task') {
    const eventKind = event['kind'];
    return (
      eventKind === 'task.removed' ||
      (['task.snapshot', 'task.status', 'task.resynced'].includes(String(eventKind)) &&
        ['completed', 'failed', 'canceled'].includes(String(event['status'])))
    );
  }
  return [
    'workflow:completed',
    'workflow:failed',
    'workflow:cancelled',
    'workflow:timed-out',
  ].includes(String(event['kind']));
}

async function watch(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  const kind = requiredKind(parsed);
  const rawId = identifier(parsed);
  const requestedCursor = option(parsed, 'cursor');
  const headers = new Headers({ accept: 'text/event-stream' });
  if (requestedCursor !== undefined) headers.set('Last-Event-ID', requestedCursor);
  const path =
    kind === 'task' ? taskPath(rawId, requestedCursor) : workflowPath(rawId, requestedCursor);
  const response = await stream(target, path, parsed, dependencies, { headers });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: RecordValue[] = [];
  const seen = new Set<string>();
  let buffer = '';
  let cursor = requestedCursor;
  let terminalSeen = false;
  let failed = false;
  let pendingInput = false;
  let detached = false;
  const write =
    parsed.output === 'text' || parsed.output === 'jsonl' ? dependencies.writeStdout : undefined;
  dependencies.signal?.addEventListener(
    'abort',
    () => {
      detached = true;
      void reader.cancel();
    },
    { once: true },
  );
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      buffer += next.value;
      const parsedFrames = parseSse(buffer);
      buffer = parsedFrames.rest;
      for (const frame of parsedFrames.frames) {
        const payload = record(frame.data);
        if (payload === undefined) continue;
        const frameCursor =
          frame.id ?? (typeof payload['cursor'] === 'string' ? payload['cursor'] : undefined);
        if (frameCursor !== undefined) {
          if (seen.has(frameCursor)) continue;
          seen.add(frameCursor);
          cursor = frameCursor;
        }
        const event = {
          kind,
          id: qualified(kind, rawId),
          cursor: cursor ?? null,
          event: payload,
        } satisfies RecordValue;
        events.push(event);
        write?.(`${JSON.stringify(event)}\n`);
        const eventPayload = record(event['event']);
        const eventKind = String(eventPayload?.['kind']);
        const status = String(eventPayload?.['status']);
        pendingInput ||= status === 'input-required' || eventKind === 'workflow:suspended';
        failed ||= status === 'failed' || eventKind === 'workflow:failed';
        if (terminal(kind, payload)) {
          terminalSeen = true;
          await reader.cancel();
          break;
        }
        if (pendingInput) {
          await reader.cancel();
          break;
        }
      }
      if (terminalSeen) break;
    }
  } catch (error) {
    if (
      detached ||
      dependencies.signal?.aborted ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      throw Object.assign(new Error('Run observation detached; no cancellation was requested.'), {
        exitCode: 130,
        identifiers: { kind, id: qualified(kind, rawId), cursor: cursor ?? null },
      });
    }
    throw error;
  }
  if (detached)
    throw Object.assign(new Error('Run observation detached; no cancellation was requested.'), {
      exitCode: 130,
      identifiers: { kind, id: qualified(kind, rawId), cursor: cursor ?? null },
    });
  if (pendingInput)
    throw Object.assign(new Error('Run is waiting for input.'), {
      exitCode: 5,
      identifiers: { kind, id: qualified(kind, rawId), cursor: cursor ?? null },
    });
  if (failed)
    throw Object.assign(new Error('Run failed.'), {
      exitCode: 1,
      identifiers: { kind, id: qualified(kind, rawId), cursor: cursor ?? null },
    });
  if (!terminalSeen && parsed.output !== 'text')
    throw Object.assign(new Error('Run event stream ended before a terminal event.'), {
      identifiers: { kind, id: qualified(kind, rawId), cursor: cursor ?? null },
    });
  return {
    data: { kind, id: qualified(kind, rawId), cursor: cursor ?? null, events },
    metadata: { streamed: write !== undefined },
  };
}

function listParams(parsed: Parsed, kind: RunKind): RecordValue {
  if (kind === 'workflow') {
    return {
      ...(option(parsed, 'workflow') === undefined ? {} : { workflow: option(parsed, 'workflow') }),
      ...(option(parsed, 'status') === undefined ? {} : { status: option(parsed, 'status') }),
      ...(numberOption(parsed, 'limit') === undefined
        ? {}
        : { limit: numberOption(parsed, 'limit') }),
      ...(numberOption(parsed, 'offset') === undefined
        ? {}
        : { offset: numberOption(parsed, 'offset') }),
    };
  }
  return {
    ...(option(parsed, 'context') === undefined ? {} : { contextId: option(parsed, 'context') }),
    ...(option(parsed, 'agent-name') === undefined
      ? {}
      : { agentName: option(parsed, 'agent-name') }),
    ...(option(parsed, 'status') === undefined ? {} : { status: option(parsed, 'status') }),
    ...(option(parsed, 'origin') === undefined ? {} : { origin: option(parsed, 'origin') }),
    ...(numberOption(parsed, 'limit') === undefined
      ? {}
      : { limit: numberOption(parsed, 'limit') }),
    ...(option(parsed, 'page-token') === undefined
      ? {}
      : { pageToken: option(parsed, 'page-token') }),
  };
}

async function list(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  const kind = option(parsed, 'kind') === 'workflow' ? 'workflow' : 'task';
  const method = kind === 'workflow' ? 'bureau.workflows.runs.list' : 'bureau.tasks.list';
  const response = await rpc(target, parsed, dependencies, method, listParams(parsed, kind));
  const body = record(response.data);
  const candidate = body?.[kind === 'workflow' ? 'runs' : 'tasks'];
  const values = Array.isArray(candidate) ? candidate : [];
  return {
    ...response,
    data: {
      kind,
      [kind === 'workflow' ? 'runs' : 'tasks']: values.map((value) =>
        withIdentifier(kind, value, 'unknown'),
      ),
      ...(body?.['nextPageToken'] === undefined ? {} : { nextPageToken: body['nextPageToken'] }),
      ...(body?.['nextOffset'] === undefined ? {} : { nextOffset: body['nextOffset'] }),
    },
  };
}

async function getOrInspect(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
  inspect: boolean,
): Promise<CliCommandResult> {
  const kind = requiredKind(parsed);
  const rawId = identifier(parsed);
  if (inspect && kind !== 'task')
    throw Object.assign(new Error('runs inspect supports --kind task only.'), { usage: true });
  const method = inspect
    ? 'bureau.tasks.inspect'
    : kind === 'task'
      ? 'bureau.tasks.get'
      : 'bureau.workflows.runs.get';
  const params: RecordValue = inspect
    ? { taskId: rawId }
    : kind === 'task'
      ? { taskId: rawId }
      : { runId: rawId };
  if (inspect && option(parsed, 'step') !== undefined)
    params['step'] = numberOption(parsed, 'step');
  const response = await rpc(target, parsed, dependencies, method, params);
  return { ...response, data: withIdentifier(kind, response.data, rawId) };
}

async function cancel(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  const kind = requiredKind(parsed);
  const rawId = identifier(parsed);
  const response =
    kind === 'task'
      ? await rpc(target, parsed, dependencies, 'bureau.tasks.cancel', {
          taskId: rawId,
          waitMilliseconds: numberOption(parsed, 'wait') ?? 0,
        })
      : await rpc(target, parsed, dependencies, 'weft.workflows.cancel', { workflowId: rawId });
  const body = record(response.data) ?? {};
  if (body['status'] === 'already-terminal')
    return { ...response, data: { kind, id: qualified(kind, rawId), ...body, terminal: true } };
  if (kind === 'task' && body['receipt'] === 'rejected') {
    throw Object.assign(
      new Error(
        `Task cancellation rejected: ${typeof body['reason'] === 'string' ? body['reason'] : 'unknown'}.`,
      ),
      { exitCode: 4 },
    );
  }
  if (body['receipt'] === 'unknown-outcome')
    throw Object.assign(new Error('Cancellation outcome is unknown.'), { exitCode: 7 });
  return { ...response, data: { kind, id: qualified(kind, rawId), ...body } };
}

/** Execute task or workflow listing, inspection, event watching, and cancellation commands. */
export async function executeRuns(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  const action = parsed.arguments[0] ?? 'list';
  if (action === 'list') return list(target, parsed, dependencies);
  if (action === 'get') return getOrInspect(target, parsed, dependencies, false);
  if (action === 'inspect') return getOrInspect(target, parsed, dependencies, true);
  if (action === 'watch' || action === 'events') return watch(target, parsed, dependencies);
  if (action === 'cancel') return cancel(target, parsed, dependencies);
  throw Object.assign(new Error('Usage: runs list|get|inspect|watch|cancel [options].'), {
    usage: true,
  });
}

/** Execute the redacted, paginated audit listing command. */
export async function executeAudit(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  if ((parsed.arguments[0] ?? 'list') !== 'list')
    throw Object.assign(new Error('Usage: audit list [options].'), { usage: true });
  const params: RecordValue = {
    ...(option(parsed, 'run-id') === undefined ? {} : { runId: option(parsed, 'run-id') }),
    ...(option(parsed, 'type') === undefined ? {} : { type: option(parsed, 'type') }),
    ...(option(parsed, 'principal') === undefined
      ? {}
      : { principal: option(parsed, 'principal') }),
    ...(numberOption(parsed, 'since') === undefined
      ? {}
      : { since: numberOption(parsed, 'since') }),
    ...(numberOption(parsed, 'until') === undefined
      ? {}
      : { until: numberOption(parsed, 'until') }),
    ...(option(parsed, 'format') === undefined ? {} : { format: option(parsed, 'format') }),
    ...(option(parsed, 'cursor') === undefined ? {} : { cursor: option(parsed, 'cursor') }),
    ...(numberOption(parsed, 'limit') === undefined
      ? {}
      : { limit: numberOption(parsed, 'limit') }),
  };
  return rpc(target, parsed, dependencies, 'bureau.audit.query', params);
}
