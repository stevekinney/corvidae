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
  const result = await request(target, '/bureau/jsonrpc', parsed, dependencies, {
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

type PublicEvent =
  | { kind: 'started'; threadId?: string; runId?: string }
  | { kind: 'text'; delta: string }
  | { kind: 'tool'; toolCallId?: string; toolCallName?: string }
  | { kind: 'snapshot'; text: string }
  | { kind: 'awaiting-input'; interruptIds: string[] }
  | { kind: 'terminal' }
  | { kind: 'error'; message: string };

function snapshotText(event: RecordValue): string {
  if (!Array.isArray(event['messages'])) return '';
  return event['messages']
    .filter((message) => record(message)?.['role'] === 'assistant')
    .map((message) => record(message)?.['content'])
    .map((content) => {
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      return content
        .map((part) => (typeof record(part)?.['text'] === 'string' ? record(part)?.['text'] : ''))
        .join('');
    })
    .join('');
}

function projectEvent(event: RecordValue): PublicEvent | undefined {
  const type = typeof event['type'] === 'string' ? event['type'] : '';
  const delta = messageFromEvent(event);
  if (delta !== undefined) return { kind: 'text', delta };
  if (type === 'RUN_STARTED')
    return {
      kind: 'started',
      ...(typeof event['threadId'] === 'string' ? { threadId: event['threadId'] } : {}),
      ...(typeof event['runId'] === 'string' ? { runId: event['runId'] } : {}),
    };
  if (type === 'MESSAGES_SNAPSHOT') {
    const text = snapshotText(event);
    return text === '' ? undefined : { kind: 'snapshot', text };
  }
  if (type.startsWith('TOOL_CALL_'))
    return {
      kind: 'tool',
      ...(typeof event['toolCallId'] === 'string' ? { toolCallId: event['toolCallId'] } : {}),
      ...(typeof event['toolCallName'] === 'string' ? { toolCallName: event['toolCallName'] } : {}),
    };
  if (type === 'RUN_FINISHED') {
    const interrupts = record(event['outcome'])?.['interrupts'];
    if (Array.isArray(interrupts)) {
      if (interrupts.length === 0) return { kind: 'terminal' };
      return {
        kind: 'awaiting-input',
        interruptIds: interrupts
          .map((item) => record(item)?.['id'])
          .filter((item): item is string => typeof item === 'string'),
      };
    }
    return { kind: 'terminal' };
  }
  if (type === 'RUN_ERROR')
    return {
      kind: 'error',
      message: typeof event['message'] === 'string' ? event['message'] : 'The agent run failed.',
    };
  return undefined;
}

function parseSse(buffer: string): {
  frames: Array<{ event: RecordValue; id?: string }>;
  rest: string;
} {
  const frames: Array<{ event: RecordValue; id?: string }> = [];
  const sections = buffer.split(/\r?\n\r?\n/);
  const rest = sections.pop() ?? '';
  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    const frameId = lines
      .find((line) => line.startsWith('id:'))
      ?.slice(3)
      .trim();
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      const value = JSON.parse(data);
      const parsed = record(value);
      if (parsed !== undefined) frames.push({ event: parsed, ...(frameId ? { id: frameId } : {}) });
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
  identifiers?: { threadId?: string; runId?: string },
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
  let threadId = typeof body?.['threadId'] === 'string' ? body['threadId'] : identifiers?.threadId;
  let runId = typeof body?.['runId'] === 'string' ? body['runId'] : identifiers?.runId;
  let text = '';
  let pendingInterrupts: unknown[] | undefined;
  let terminalSeen = false;
  let resynced = false;
  const events: PublicEvent[] = [];
  const seenDurable = new Set<string>();
  let nativeTaskId: string | undefined;
  const write = parsed.output === 'text' ? dependencies.writeStdout : undefined;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      buffer += next.value;
      const parsedFrames = parseSse(buffer);
      buffer = parsedFrames.rest;
      for (const frame of parsedFrames.frames) {
        const event = frame.event;
        const metadata = record(event['metadata']);
        const bureau = record(metadata?.['@lostgradient/bureau']);
        const durableKey =
          frame.id ??
          (bureau?.['durable'] === true && typeof bureau?.['cursor'] === 'string'
            ? bureau['cursor']
            : undefined);
        if (durableKey !== undefined) {
          if (seenDurable.has(durableKey)) continue;
          seenDurable.add(durableKey);
        }
        const projected = projectEvent(event);
        if (projected !== undefined) events.push(projected);
        if (typeof event['threadId'] === 'string') threadId = event['threadId'];
        if (typeof event['runId'] === 'string') runId = event['runId'];
        const outcome = record(event['outcome']);
        if (event['type'] === 'RUN_FINISHED') {
          terminalSeen = true;
          if (Array.isArray(outcome?.['interrupts'])) pendingInterrupts = outcome['interrupts'];
        }
        if (event['type'] === 'RUN_ERROR') {
          const message =
            typeof event['message'] === 'string' ? event['message'] : 'The agent run failed.';
          throw new Error(message);
        }
        if (requestedCursor !== undefined && event['type'] === 'MESSAGES_SNAPSHOT') resynced = true;
        if (typeof bureau?.['cursor'] === 'string' && bureau['durable'] === true)
          cursor = bureau['cursor'];
        if (typeof bureau?.['runId'] === 'string') nativeTaskId = bureau['runId'];
        const delta = projected?.kind === 'text' ? projected.delta : undefined;
        if (delta !== undefined) {
          text += delta;
          write?.(delta);
        }
        if (projected?.kind === 'snapshot') {
          const snapshotDelta = text.startsWith(projected.text)
            ? ''
            : projected.text.startsWith(text)
              ? projected.text.slice(text.length)
              : projected.text;
          if (snapshotDelta !== '') {
            text += snapshotDelta;
            write?.(snapshotDelta);
          }
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
  if (!terminalSeen)
    throw Object.assign(
      new Error(
        `The chat stream ended before a terminal result (thread ${threadId ?? 'unknown'}, run ${runId ?? 'unknown'}).`,
      ),
      { identifiers: { threadId, runId, cursor } },
    );
  if (pendingInterrupts !== undefined && pendingInterrupts.length > 0) {
    if (!parsed.noInput && dependencies.stdinIsTTY === true && dependencies.prompt !== undefined) {
      const firstInterrupt = record(pendingInterrupts[0]);
      const decisionOnly = record(firstInterrupt)?.['reason'] === 'tool-approval';
      let answer: string;
      try {
        answer = await dependencies.prompt(
          decisionOnly ? 'Tool approval (approve, deny, or reject): ' : 'Input required: ',
          dependencies.signal,
        );
      } catch (error) {
        if (dependencies.signal?.aborted)
          throw Object.assign(
            new Error('Chat stream detached; resume with the reported identifiers.'),
            {
              exitCode: 130,
              identifiers: { threadId, runId, cursor },
            },
          );
        throw error;
      }
      if (decisionOnly && !['approve', 'deny', 'reject'].includes(answer.trim().toLowerCase()))
        throw new Error('Tool approval requires an explicit approve, deny, or reject decision.');
      return runStream(target, parsed, dependencies, path, {
        ...body,
        resume: pendingInterrupts.map((interrupt) => ({
          interruptId: record(interrupt)?.['id'],
          status: 'resolved',
          payload: decisionOnly
            ? { decision: answer.trim().toLowerCase() }
            : { decision: 'approve', answer },
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
    data: {
      threadId,
      runId,
      taskId: nativeTaskId,
      cursor,
      text,
      events,
      ...(resynced ? { resynced: true } : {}),
    },
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
    const threadId = option(parsed, 'thread') ?? id('thread');
    const runId = option(parsed, 'run') ?? id('run');
    if (option(parsed, 'cursor') !== undefined && option(parsed, 'thread') !== undefined)
      return runStream(
        target,
        parsed,
        dependencies,
        `/bureau/ag-ui/threads/${encodeURIComponent(threadId)}/run`,
        undefined,
        { threadId, runId },
      );
    const messageFile = option(parsed, 'message-file');
    let message =
      messageFile === undefined
        ? (() => {
            const direct = option(parsed, 'message') ?? parsed.arguments.join(' ');
            return direct || '';
          })()
        : await readFile(messageFile, 'utf8');
    if (!message && parsed.noInput)
      throw Object.assign(new Error('chat requires a message when --no-input is set.'), {
        exitCode: 5,
      });
    if (!message && dependencies.stdinIsTTY === true && dependencies.prompt !== undefined) {
      try {
        message = await dependencies.prompt('Message: ', dependencies.signal);
      } catch (error) {
        if (dependencies.signal?.aborted)
          throw Object.assign(
            new Error('Chat stream detached; resume with the reported identifiers.'),
            {
              exitCode: 130,
              identifiers: { threadId, runId },
            },
          );
        throw error;
      }
    }
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
      const modality =
        asset['modality'] === 'image' || asset['modality'] === 'audio' ? asset['modality'] : 'file';
      content = [
        { type: 'text', text: message },
        { type: modality, source: { type: 'file', provider: 'bureau', value: assetId } },
      ];
    }
    return runStream(
      target,
      parsed,
      dependencies,
      `/bureau/ag-ui/agents/${encodeURIComponent(agent)}/run`,
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
    if (action === 'cancel') {
      const taskId = option(parsed, 'task-id') ?? option(parsed, 'run') ?? parsed.arguments[1];
      if (taskId === undefined)
        throw Object.assign(new Error('chats cancel requires --task-id <id>.'), { usage: true });
      return request(
        target,
        `/bureau/ag-ui/runs/${encodeURIComponent(taskId)}/cancel`,
        parsed,
        dependencies,
        { method: 'POST' },
      );
    }
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
      if (option(parsed, 'expected-revision') !== undefined)
        params['expectedRevision'] = Number(option(parsed, 'expected-revision'));
      const setting = option(parsed, 'effort') ?? option(parsed, 'permission-mode');
      if (option(parsed, 'model') !== undefined) {
        const model = option(parsed, 'model')!;
        const separator = model.indexOf('/');
        params['override'] = {
          provider:
            option(parsed, 'provider') ?? (separator === -1 ? model : model.slice(0, separator)),
          model: separator === -1 ? model : model.slice(separator + 1),
        };
      } else if (option(parsed, 'effort') !== undefined) params['effort'] = setting;
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
      return rpc(target, parsed, dependencies, 'bureau.reviews.get', { id: reviewId });
    if (action === 'approve' || action === 'reject')
      return rpc(target, parsed, dependencies, 'bureau.reviews.resolve', {
        id: reviewId,
        decision: action === 'approve' ? 'approve' : 'reject',
        ...(action === 'reject' ? { reason: option(parsed, 'reason') ?? 'Rejected by user.' } : {}),
        ...(option(parsed, 'round') === undefined
          ? {}
          : { round: Number(option(parsed, 'round')) }),
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
