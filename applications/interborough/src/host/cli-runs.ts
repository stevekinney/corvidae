import { formatCost } from '../lib/format/cost.ts';
import {
  catalogRead,
  faultRefusedBeforeAnyEffect,
  request,
  stream,
  type CliTarget,
} from './cli-client-transport.ts';
import type { CliClientDependencies, CliCommandResult, Parsed } from './cli-client.ts';
import { isDryRun } from './cli-destructive.ts';

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
  return `/bureau/v1/subscriptions/bureau.tasks.events?${query}`;
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
    throw Object.assign(new Error(`Run ${qualified(kind, rawId)} is waiting for input.`), {
      exitCode: 5,
      identifiers: { kind, id: qualified(kind, rawId), cursor: cursor ?? null },
    });
  if (failed)
    throw Object.assign(new Error(`Run ${qualified(kind, rawId)} failed.`), {
      exitCode: 1,
      identifiers: { kind, id: qualified(kind, rawId), cursor: cursor ?? null },
    });
  if (!terminalSeen)
    throw Object.assign(
      new Error(
        `Run event stream ended before a terminal event (resume ${qualified(kind, rawId)} from ${cursor ?? 'beginning'}).`,
      ),
      { identifiers: { kind, id: qualified(kind, rawId), cursor: cursor ?? null } },
    );
  return {
    data: { kind, id: qualified(kind, rawId), cursor: cursor ?? null, events },
    metadata: { streamed: write !== undefined },
  };
}

function listParams(parsed: Parsed, kind: RunKind): RecordValue {
  if (kind === 'workflow') {
    const cursor = option(parsed, 'cursor') ?? option(parsed, 'page-token');
    const cursorOffset = cursor === undefined ? undefined : Number(cursor);
    if (cursorOffset !== undefined && (!Number.isInteger(cursorOffset) || cursorOffset < 0))
      throw Object.assign(new Error('Workflow pagination cursor must be a nonnegative integer.'), {
        usage: true,
      });
    return {
      ...(option(parsed, 'workflow') === undefined ? {} : { workflow: option(parsed, 'workflow') }),
      ...(option(parsed, 'status') === undefined ? {} : { status: option(parsed, 'status') }),
      ...(numberOption(parsed, 'limit') === undefined
        ? {}
        : { limit: numberOption(parsed, 'limit') }),
      ...(numberOption(parsed, 'offset') === undefined
        ? {}
        : { offset: numberOption(parsed, 'offset') }),
      ...(cursorOffset === undefined ? {} : { offset: cursorOffset }),
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
    ...(option(parsed, 'cursor') === undefined
      ? option(parsed, 'page-token') === undefined
        ? {}
        : { pageToken: option(parsed, 'page-token') }
      : { pageToken: option(parsed, 'cursor') }),
  };
}

async function list(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  const requestedKind = option(parsed, 'kind');
  if (requestedKind !== undefined && requestedKind !== 'task' && requestedKind !== 'workflow')
    throw Object.assign(new Error('Option --kind must be task or workflow.'), { usage: true });
  const kind: RunKind = requestedKind === 'workflow' ? 'workflow' : 'task';
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
  const step = inspect ? numberOption(parsed, 'step') : undefined;
  const response = inspect
    ? await catalogRead(target, parsed, dependencies, 'bureau.tasks.inspect', {
        taskId: rawId,
        ...(step === undefined ? {} : { step }),
      })
    : kind === 'task'
      ? await catalogRead(target, parsed, dependencies, 'bureau.tasks.get', { taskId: rawId })
      : await catalogRead(target, parsed, dependencies, 'bureau.workflows.runs.get', {
          runId: rawId,
        });
  const data = withIdentifier(kind, response.data, rawId);
  // A task read as text says how it stands, and what it used and cost (COR-2525); as JSON it is the
  // task as the Bureau answered it, `usage.costUsd` and all.
  if (kind === 'task' && !inspect && parsed.output === 'text') {
    return { ...response, data: taskText(data) };
  }
  return { ...response, data };
}

/** The tokens a task used, as a count with thousands separators. */
const TOKEN_COUNT = new Intl.NumberFormat('en-US');

/**
 * A task as `runs get --kind task` prints it as text: its identifier, status, agent, times and why
 * it ended, then its tokens and its cost when the Bureau counted them. `--output json` is the task
 * whole, as the Bureau answered it. A task with no priced request has no cost line,
 * never `Cost: $0.00`.
 */
function taskText(task: RecordValue): string {
  const usage = record(task['usage']);
  const totalTokens = usage?.['totalTokens'];
  const costUsd = usage?.['costUsd'];
  const cost = formatCost(typeof costUsd === 'number' ? costUsd : null);
  const lines = [
    `Run: ${String(task['id'])}`,
    ...(typeof task['status'] === 'string' ? [`Status: ${task['status']}`] : []),
    ...(typeof task['agentName'] === 'string' ? [`Agent: ${task['agentName']}`] : []),
    ...(typeof task['createdAt'] === 'string' ? [`Started: ${task['createdAt']}`] : []),
    ...(typeof task['updatedAt'] === 'string' ? [`Updated: ${task['updatedAt']}`] : []),
    ...(typeof task['finishReason'] === 'string' ? [`Finish reason: ${task['finishReason']}`] : []),
    ...(typeof task['statusMessage'] === 'string' && task['statusMessage'] !== ''
      ? [`Message: ${task['statusMessage']}`]
      : []),
    ...(typeof totalTokens === 'number' && totalTokens > 0
      ? [`Tokens: ${TOKEN_COUNT.format(totalTokens)}`]
      : []),
    ...(cost === undefined ? [] : [`Cost: ${cost}`]),
  ];
  return lines.join('\n');
}

async function cancel(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  const kind = requiredKind(parsed);
  const rawId = identifier(parsed);
  // The operation's own answer to `dryRun: true`, printed as the server sent it.
  if (isDryRun(parsed))
    return kind === 'task'
      ? rpc(target, parsed, dependencies, 'bureau.tasks.cancel', { taskId: rawId, dryRun: true })
      : rpc(target, parsed, dependencies, 'weft.workflows.cancel', {
          workflowId: rawId,
          dryRun: true,
        });
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

/** A run's explanation as the lines a person reads: the sentence, then each fact, then what to do. */
function explanationText(explanation: RecordValue): string {
  const words = (value: unknown): string => (typeof value === 'string' ? value : '');
  const cause = record(explanation['cause']) ?? {};
  const step = record(explanation['step']);
  const lines = [words(explanation['summary'])];
  const category = cause['category'];
  lines.push(`Cause: ${typeof category === 'string' ? category : 'not classified'}`);
  for (const [label, key] of [
    ['Code', 'code'],
    ['Kind', 'kind'],
  ] as const) {
    if (typeof cause[key] === 'string') lines.push(`${label}: ${cause[key]}`);
  }
  if (step !== undefined && typeof step['index'] === 'number')
    lines.push(`Step: ${step['index']} ${words(step['label'])}`);
  if (typeof explanation['tries'] === 'number') lines.push(`Tries: ${explanation['tries']}`);
  const verdicts = Array.isArray(explanation['verdicts']) ? explanation['verdicts'] : [];
  for (const verdict of verdicts.map(record)) {
    if (verdict === undefined) continue;
    const at = typeof verdict['step'] === 'number' ? ` at step ${verdict['step']}` : '';
    lines.push(`Guardrail: ${words(verdict['name'])} (${words(verdict['outcome'])})${at}`);
  }
  lines.push(`Next: ${words(explanation['remediation'])}`);
  const commands = Array.isArray(explanation['nextCommands']) ? explanation['nextCommands'] : [];
  for (const command of commands) lines.push(`  ${words(command)}`);
  return lines.join('\n');
}

/**
 * What a model wrote about a failed run, as the lines a person reads: the text, then which model
 * wrote it, when, and what it cost (COR-2534). A model with no price has no cost line, never
 * `Cost: $0.00`.
 */
function modelExplanationText(explanation: RecordValue): string {
  const words = (value: unknown): string => (typeof value === 'string' ? value : '');
  const costUsd = explanation['costUsd'];
  const cost = formatCost(typeof costUsd === 'number' ? costUsd : null);
  return [
    words(explanation['text']),
    '',
    `Written by ${words(explanation['model'])} at ${words(explanation['generatedAt'])}`,
    ...(cost === undefined ? [] : [`Cost of this explanation: ${cost}`]),
  ].join('\n');
}

/**
 * Why a run failed, from what Bureau stored: `bureau.tasks.explain`, which takes either kind of run
 * by its identifier, so no `--kind` is needed. A run that did not fail is the server's
 * `Unprocessable` fault with its message and remediation, which is a misuse of the command, so it
 * exits with the usage status (2) and says what the server said (COR-2533).
 *
 * With `--model`, a model writes the longer explanation of a failed agent run instead
 * (`bureau.tasks.explanation.generate`): it spends tokens, stores the text on the task, and prints it
 * with the model's name and what it cost (COR-2534).
 */
async function explain(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  const rawId = identifier(parsed);
  try {
    if (parsed.options.get('model') === true) {
      const response = await rpc(
        target,
        parsed,
        dependencies,
        'bureau.tasks.explanation.generate',
        {
          runId: rawId,
        },
      );
      const written = record(record(response.data)?.['explanation']);
      if (written === undefined || parsed.output !== 'text') return response;
      return { ...response, data: modelExplanationText(written) };
    }
    const response = await catalogRead(target, parsed, dependencies, 'bureau.tasks.explain', {
      runId: rawId,
    });
    const explanation = record(response.data);
    if (explanation === undefined || parsed.output !== 'text') return response;
    return { ...response, data: explanationText(explanation) };
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'faultCode') === 'Unprocessable')
      throw Object.assign(error, { usage: true });
    // `--model` writes the task's record and spends tokens, so a failure the CLI cannot read is an
    // unknown outcome (exit 7); a fault that guarantees nothing ran (no provider connected, for
    // one) is a plain refusal (exit 1), as for `runs retry`.
    if (
      parsed.options.get('model') === true &&
      error instanceof Error &&
      faultRefusedBeforeAnyEffect(error)
    ) {
      const status: unknown = Reflect.get(error, 'status');
      if (status !== 401 && status !== 403 && status !== 409)
        throw Object.assign(error, { exitCode: 1 });
    }
    throw error;
  }
}

/**
 * Run a failed instance of a workflow file again from the step it failed at:
 * `bureau.workflows.runs.retry`, which runs that step when `--step` names none (COR-2533). An agent
 * run has no step to run again, so `--kind task` is a usage error. A retry changes a run, so an
 * outcome the CLI cannot know is exit 7 (see `executeCli`).
 */
async function retry(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  const kind = option(parsed, 'kind');
  if (kind !== undefined && kind !== 'workflow')
    throw Object.assign(new Error('runs retry supports --kind workflow only.'), { usage: true });
  const rawId = identifier(parsed);
  const step = numberOption(parsed, 'step');
  if (step === 0) throw Object.assign(new Error('Option --step counts from 1.'), { usage: true });
  let response: CliCommandResult;
  try {
    response = await rpc(target, parsed, dependencies, 'bureau.workflows.runs.retry', {
      runId: rawId,
      ...(step === undefined ? {} : { step }),
    });
  } catch (error) {
    // Only a fault that guarantees nothing ran is a refusal (exit 1, or the authorization and
    // conflict statuses `executeCli` already gives a 401, 403 or 409). `EngineFailure`,
    // `Unavailable` and `Timeout` can come after the retry committed, for example when a later
    // write of its receipt fails, so they stay an unknown outcome (exit 7), as does a request that
    // got no answer.
    if (error instanceof Error && faultRefusedBeforeAnyEffect(error)) {
      const status: unknown = Reflect.get(error, 'status');
      if (status !== 401 && status !== 403 && status !== 409)
        throw Object.assign(error, { exitCode: 1 });
    }
    throw error;
  }
  return {
    ...response,
    data: { kind: 'workflow', ...record(response.data), id: qualified('workflow', rawId) },
  };
}

/**
 * Execute task or workflow listing, inspection, explanation, retry, event watching, and
 * cancellation commands.
 */
export async function executeRuns(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  const action = parsed.arguments[0] ?? (parsed.command === 'events' ? 'watch' : 'list');
  if (action === 'list') return list(target, parsed, dependencies);
  if (action === 'get') return getOrInspect(target, parsed, dependencies, false);
  if (action === 'inspect') return getOrInspect(target, parsed, dependencies, true);
  if (action === 'watch' || action === 'events') return watch(target, parsed, dependencies);
  if (action === 'cancel') return cancel(target, parsed, dependencies);
  if (action === 'explain') return explain(target, parsed, dependencies);
  if (action === 'retry') return retry(target, parsed, dependencies);
  throw Object.assign(
    new Error('Usage: runs list|get|inspect|explain|retry|watch|cancel [options].'),
    {
      usage: true,
    },
  );
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
