import { readFile } from 'node:fs/promises';

import { uploadAttachment } from './cli-chat-assets.ts';
import { request, stream, type CliTarget } from './cli-client-transport.ts';
import type { CliClientDependencies, CliCommandResult, Parsed } from './cli-client.ts';

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function option(parsed: Parsed, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === 'string' ? value : undefined;
}

async function rpc(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
  method: string,
  params: RecordValue,
): Promise<CliCommandResult> {
  const result = await request(target, '/jsonrpc', parsed, dependencies, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: id('cli'), method, params }),
  });
  return record(result.data)?.['result'] === undefined
    ? result
    : { ...result, data: record(result.data)?.['result'] };
}

function messageFromEvent(event: RecordValue): string | undefined {
  const type = event['type'];
  if (type === 'TEXT_MESSAGE_CONTENT' && typeof event['delta'] === 'string') return event['delta'];
  if (type === 'TEXT_MESSAGE_CHUNK' && typeof event['delta'] === 'string') return event['delta'];
  return undefined;
}

function eventKind(event: RecordValue): string {
  const type = typeof event['type'] === 'string' ? event['type'] : 'UNKNOWN';
  if (type.startsWith('TOOL_CALL_')) return 'tool';
  if (type === 'RUN_FINISHED') return 'terminal';
  if (type === 'RUN_ERROR') return 'error';
  if (type === 'RUN_STARTED') return 'started';
  if (type === 'RUN_FINISHED' && event['interrupt'] !== undefined) return 'awaiting-input';
  return 'event';
}

function parseSse(buffer: string): { frames: RecordValue[]; rest: string } {
  const frames: RecordValue[] = [];
  const sections = buffer.split(/\r?\n\r?\n/);
  const rest = sections.pop() ?? '';
  for (const section of sections) {
    const data = section
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      const value = JSON.parse(data);
      const parsed = record(value);
      if (parsed !== undefined) frames.push(parsed);
    } catch {
      // Ignore comments and malformed keep-alive frames; valid AG-UI frames remain strict JSON.
    }
  }
  return { frames, rest };
}

async function runStream(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
  path: string,
  body?: RecordValue,
): Promise<CliCommandResult> {
  const streamHeaders: Record<string, string> = { accept: 'text/event-stream' };
  const requestedCursor = option(parsed, 'cursor');
  if (requestedCursor !== undefined) streamHeaders['Last-Event-ID'] = requestedCursor;
  let response: Response;
  try {
    response = await stream(target, path, parsed, dependencies, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...streamHeaders,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (dependencies.signal?.aborted) {
      throw Object.assign(
        new Error('Chat stream detached; resume with the reported identifiers.'),
        {
          exitCode: 130,
          identifiers: {
            threadId: body?.['threadId'],
            runId: body?.['runId'],
            cursor: requestedCursor,
          },
        },
      );
    }
    throw error;
  }
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let cursor: string | undefined;
  let threadId = typeof body?.['threadId'] === 'string' ? body['threadId'] : undefined;
  let runId = typeof body?.['runId'] === 'string' ? body['runId'] : undefined;
  let text = '';
  let pendingInterrupts: unknown[] | undefined;
  let resynced = false;
  const events: RecordValue[] = [];
  const seen = new Set<string>();
  const write = dependencies.writeStdout;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      buffer += next.value;
      const parsedFrames = parseSse(buffer);
      buffer = parsedFrames.rest;
      for (const event of parsedFrames.frames) {
        const key = typeof event['id'] === 'string' ? event['id'] : JSON.stringify(event);
        if (seen.has(key)) continue;
        seen.add(key);
        events.push({ kind: eventKind(event), event });
        if (typeof event['threadId'] === 'string') threadId = event['threadId'];
        if (typeof event['runId'] === 'string') runId = event['runId'];
        const outcome = record(event['outcome']);
        if (event['type'] === 'RUN_FINISHED' && Array.isArray(outcome?.['interrupts']))
          pendingInterrupts = outcome['interrupts'];
        if (requestedCursor !== undefined && event['type'] === 'MESSAGES_SNAPSHOT') resynced = true;
        const metadata = record(event['metadata']);
        const bureau = record(metadata?.['@lostgradient/bureau']);
        if (typeof bureau?.['cursor'] === 'string' && bureau['durable'] === true)
          cursor = bureau['cursor'];
        const delta = messageFromEvent(event);
        if (delta !== undefined) {
          text += delta;
          write?.(delta);
        }
      }
    }
  } catch (error) {
    if (dependencies.signal?.aborted) {
      throw Object.assign(
        new Error('Chat stream detached; resume with the reported identifiers.'),
        {
          exitCode: 130,
          identifiers: { threadId, runId, cursor },
        },
      );
    }
    throw error;
  }
  if (pendingInterrupts !== undefined && pendingInterrupts.length > 0) {
    if (dependencies.stdinIsTTY === true && dependencies.prompt !== undefined) {
      const answer = await dependencies.prompt('Input required: ');
      return runStream(target, parsed, dependencies, path, {
        ...body,
        resume: pendingInterrupts.map((interrupt) => ({
          interruptId: record(interrupt)?.['id'],
          status: 'resolved',
          payload: { answer },
        })),
      });
    }
    throw Object.assign(
      new Error(
        `Human input is required (thread ${threadId ?? 'unknown'}, run ${runId ?? 'unknown'}).`,
      ),
      { exitCode: 5, identifiers: { threadId, runId, interrupts: pendingInterrupts } },
    );
  }
  return {
    data: { threadId, runId, cursor, text, events, ...(resynced ? { resynced: true } : {}) },
    metadata: { streamed: write !== undefined },
  };
}

/** Execute chat and chat-management commands through AG-UI and Bureau operations. */
export async function executeChat(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  const action = parsed.command === 'chat' ? undefined : parsed.arguments[0];
  if (parsed.command === 'chat') {
    const agent = option(parsed, 'agent') ?? parsed.arguments[0];
    if (!agent) throw Object.assign(new Error('chat requires --agent <name>.'), { usage: true });
    const messageFile = option(parsed, 'message-file');
    let message =
      messageFile === undefined
        ? (() => {
            const direct = option(parsed, 'message') ?? parsed.arguments.join(' ');
            return direct || '';
          })()
        : await readFile(messageFile, 'utf8');
    if (!message && dependencies.stdin !== undefined) message = await dependencies.stdin();
    if (!message)
      throw Object.assign(new Error('chat requires a message or --message-file.'), { usage: true });
    let content: string | unknown[] = message;
    const attachmentPath = option(parsed, 'attachment');
    if (attachmentPath !== undefined) {
      const asset = await uploadAttachment(target, parsed, dependencies, attachmentPath);
      const assetId = asset['assetId'];
      if (typeof assetId !== 'string')
        throw new Error('The host returned no completed asset identifier.');
      content = [
        { type: 'text', text: message },
        { type: 'file', provider: 'bureau', value: assetId },
      ];
    }
    const threadId = option(parsed, 'thread') ?? id('thread');
    const runId = option(parsed, 'run') ?? id('run');
    if (option(parsed, 'cursor') !== undefined && option(parsed, 'thread') !== undefined) {
      return runStream(
        target,
        parsed,
        dependencies,
        `/ag-ui/threads/${encodeURIComponent(threadId)}/run`,
      );
    }
    return runStream(
      target,
      parsed,
      dependencies,
      `/ag-ui/agents/${encodeURIComponent(agent)}/run`,
      {
        threadId,
        runId,
        messages: [{ id: id('message'), role: 'user', content }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
    );
  }
  const methodByAction: Record<string, string> = {
    list: 'bureau.contexts.list',
    get: 'bureau.contexts.get',
    send: 'bureau.contexts.input',
    fork: 'bureau.contexts.fork',
    rename: 'bureau.contexts.rename',
    delete: 'bureau.contexts.delete',
    configure: 'bureau.contexts.steer',
  };
  if (parsed.command === 'chats' && action !== undefined) {
    const method = methodByAction[action];
    if (method === undefined)
      throw Object.assign(new Error(`Unknown chats action: ${action}.`), { usage: true });
    const contextId = option(parsed, 'context') ?? parsed.arguments[1];
    const params: RecordValue = contextId === undefined ? {} : { contextId };
    if (action === 'send')
      params['input'] = {
        id: option(parsed, 'input-id') ?? id('input'),
        payload: option(parsed, 'message') ?? (await dependencies.stdin?.()) ?? '',
      };
    if (action === 'fork') {
      params['commandId'] = option(parsed, 'command-id') ?? id('fork');
      params['throughMessageId'] = option(parsed, 'through-message-id') ?? null;
    }
    if (action === 'rename') params['title'] = option(parsed, 'title') ?? null;
    if (action === 'delete') params['waitMilliseconds'] = Number(option(parsed, 'wait') ?? 0);
    if (action === 'configure') {
      params['commandId'] = option(parsed, 'command-id') ?? id('steer');
      params['expectedRevision'] = Number(option(parsed, 'expected-revision') ?? 0);
      const setting = option(parsed, 'effort') ?? option(parsed, 'permission-mode');
      if (option(parsed, 'model') !== undefined)
        params['override'] = { model: option(parsed, 'model') };
      else if (option(parsed, 'effort') !== undefined) params['effort'] = setting;
      else params['permissionMode'] = setting;
    }
    return rpc(target, parsed, dependencies, method, params);
  }
  throw Object.assign(
    new Error('Usage: chat or chats list|get|send|fork|rename|delete|configure.'),
    { usage: true },
  );
}

/** Execute review decisions and human-input responses through management operations. */
export async function executeReviewsOrRuns(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  if (parsed.command === 'reviews') {
    const action = parsed.arguments[0];
    if (action === 'list') return rpc(target, parsed, dependencies, 'bureau.reviews.list', {});
    const reviewId = option(parsed, 'review-id') ?? parsed.arguments[1];
    if (action === 'get')
      return rpc(target, parsed, dependencies, 'bureau.reviews.get', { reviewId });
    if (action === 'approve' || action === 'reject')
      return rpc(target, parsed, dependencies, 'bureau.reviews.resolve', {
        reviewId,
        decision: action === 'approve' ? 'approve' : 'reject',
        ...(action === 'reject' ? { reason: option(parsed, 'reason') ?? 'Rejected by user.' } : {}),
        round: Number(option(parsed, 'round') ?? 0),
      });
  }
  if (parsed.command === 'runs' && parsed.arguments[0] === 'respond') {
    const params: RecordValue = {
      taskId: option(parsed, 'task-id') ?? parsed.arguments[1],
      messageId: option(parsed, 'message-id') ?? id('response'),
    };
    const answer = option(parsed, 'answer');
    if (answer !== undefined) params['answer'] = answer;
    else params['decision'] = option(parsed, 'decision') ?? 'approve';
    if (option(parsed, 'signal-name') !== undefined)
      params['signalName'] = option(parsed, 'signal-name');
    if (option(parsed, 'call-id') !== undefined) params['callId'] = option(parsed, 'call-id');
    if (option(parsed, 'reason') !== undefined) params['reason'] = option(parsed, 'reason');
    return rpc(target, parsed, dependencies, 'bureau.tasks.respond', params);
  }
  throw Object.assign(new Error('Usage: reviews list|get|approve|reject or runs respond.'), {
    usage: true,
  });
}
