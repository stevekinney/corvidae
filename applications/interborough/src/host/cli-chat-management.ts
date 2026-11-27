import { PERMISSION_MODES } from '@lostgradient/operative';

import { EFFORTS } from '../lib/agent-definitions.ts';
import { catalogCall, request, type CliTarget } from './cli-client-transport.ts';
import type { CliClientDependencies, CliCommandResult, Parsed } from './cli-client.ts';
import { isDryRun } from './cli-destructive.ts';

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

/** Manage saved conversations through Bureau's command surface. */
export async function executeChats(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  const action = parsed.arguments[0];
  const methodByAction: Record<string, string> = {
    list: 'bureau.contexts.list',
    get: 'bureau.contexts.get',
    send: 'bureau.contexts.input',
    fork: 'bureau.contexts.fork',
    rename: 'bureau.contexts.rename',
    delete: 'bureau.contexts.delete',
    configure: 'bureau.contexts.steer',
  };
  if (action !== undefined) {
    if (action === 'cancel') {
      const taskId = option(parsed, 'task-id') ?? option(parsed, 'run') ?? parsed.arguments[1];
      if (taskId === undefined)
        throw Object.assign(new Error('chats cancel requires --task-id <id>.'), { usage: true });
      // The cancel route goes through `bureau.tasks.cancel`, which answers a dry run itself.
      if (isDryRun(parsed))
        return catalogCall(target, parsed, dependencies, 'bureau.tasks.cancel', {
          taskId,
          dryRun: true,
        });
      return request(
        target,
        `/bureau/ag-ui/runs/${encodeURIComponent(taskId)}/cancel`,
        parsed,
        dependencies,
        { method: 'POST' },
      );
    }
    if (!Object.hasOwn(methodByAction, action))
      throw Object.assign(new Error(`Unknown chats action: ${action}.`), { usage: true });
    const method = methodByAction[action]!;
    const contextId = option(parsed, 'context') ?? parsed.arguments[1];
    const originalCall = (input: RecordValue) =>
      rpc(target, parsed, dependencies, method, {
        ...(contextId === undefined ? {} : { contextId }),
        ...input,
      });
    if (action === 'list')
      return contextId === undefined
        ? catalogCall(target, parsed, dependencies, 'bureau.contexts.list', {})
        : originalCall({});
    if (action === 'get')
      return contextId === undefined
        ? originalCall({})
        : catalogCall(target, parsed, dependencies, 'bureau.contexts.get', { contextId });
    if (action === 'send') {
      const input = {
        id: option(parsed, 'input-id') ?? id('input'),
        payload: option(parsed, 'message') ?? (await dependencies.stdin?.()) ?? '',
      };
      return contextId === undefined
        ? originalCall({ input })
        : catalogCall(target, parsed, dependencies, 'bureau.contexts.input', { contextId, input });
    }
    if (action === 'fork') {
      const commandId = option(parsed, 'command-id') ?? id('fork');
      const throughMessageId = option(parsed, 'through-message-id') ?? null;
      const fork = { commandId, throughMessageId };
      return contextId === undefined
        ? originalCall(fork)
        : catalogCall(target, parsed, dependencies, 'bureau.contexts.fork', { contextId, ...fork });
    }
    if (action === 'rename') {
      const title = option(parsed, 'title') ?? null;
      return contextId === undefined
        ? originalCall({ title })
        : catalogCall(target, parsed, dependencies, 'bureau.contexts.rename', { contextId, title });
    }
    if (action === 'delete') {
      const deletion = {
        waitMilliseconds: Number(option(parsed, 'wait') ?? 0),
        ...(isDryRun(parsed) ? { dryRun: true } : {}),
      };
      return contextId === undefined
        ? originalCall(deletion)
        : catalogCall(target, parsed, dependencies, 'bureau.contexts.delete', {
            contextId,
            ...deletion,
          });
    }
    if (action === 'configure') {
      const revision = option(parsed, 'expected-revision');
      const command = {
        commandId: option(parsed, 'command-id') ?? id('steer'),
        ...(revision === undefined ? {} : { expectedRevision: Number(revision) }),
      };
      const model = option(parsed, 'model');
      const separator = model?.indexOf('/') ?? -1;
      const override =
        model === undefined
          ? undefined
          : {
              provider:
                option(parsed, 'provider') ??
                (separator === -1 ? model : model.slice(0, separator)),
              model: separator === -1 ? model : model.slice(separator + 1),
            };
      const requestedEffort = option(parsed, 'effort');
      const requestedMode = option(parsed, 'permission-mode');
      const effort = EFFORTS.find((value) => value === requestedEffort);
      const permissionMode = PERMISSION_MODES.find((value) => value === requestedMode);
      const setting =
        override !== undefined
          ? { override }
          : effort !== undefined
            ? { effort }
            : permissionMode === undefined
              ? {}
              : { permissionMode };
      if (
        contextId === undefined ||
        (override === undefined &&
          (requestedEffort !== undefined ? effort === undefined : permissionMode === undefined))
      )
        return originalCall({
          ...command,
          ...(override !== undefined
            ? { override }
            : requestedEffort === undefined
              ? { permissionMode: requestedMode }
              : { effort: requestedEffort }),
        });
      return catalogCall(target, parsed, dependencies, 'bureau.contexts.steer', {
        contextId,
        ...command,
        ...setting,
      });
    }
  }
  throw Object.assign(
    new Error('Usage: chats list|get|send|fork|rename|delete|configure|cancel.'),
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
    if (action === 'list')
      return catalogCall(target, parsed, dependencies, 'bureau.reviews.list', {});
    const reviewId = option(parsed, 'review-id') ?? parsed.arguments[1];
    if (action === 'get') {
      if (reviewId === undefined)
        return rpc(target, parsed, dependencies, 'bureau.reviews.get', {});
      return catalogCall(target, parsed, dependencies, 'bureau.reviews.get', { id: reviewId });
    }
    if (action === 'approve' || action === 'reject') {
      const round = option(parsed, 'round');
      const decision = {
        decision: action,
        ...(action === 'reject' ? { reason: option(parsed, 'reason') ?? 'Rejected by user.' } : {}),
        ...(round === undefined ? {} : { round: Number(round) }),
      } as const;
      if (reviewId === undefined)
        return rpc(target, parsed, dependencies, 'bureau.reviews.resolve', decision);
      return catalogCall(target, parsed, dependencies, 'bureau.reviews.resolve', {
        id: reviewId,
        ...decision,
      });
    }
  }
  if (parsed.command === 'runs' && parsed.arguments[0] === 'respond') {
    const taskId = option(parsed, 'task-id') ?? parsed.arguments[1];
    const answer = option(parsed, 'answer');
    const decision = option(parsed, 'decision') ?? 'approve';
    const signalName = option(parsed, 'signal-name');
    const callId = option(parsed, 'call-id');
    const reason = option(parsed, 'reason');
    const response = {
      messageId: option(parsed, 'message-id') ?? id('response'),
      ...(signalName === undefined ? {} : { signalName }),
      ...(callId === undefined ? {} : { callId }),
      ...(reason === undefined ? {} : { reason }),
    };
    const responseChoice =
      answer !== undefined
        ? { answer }
        : decision === 'approve' || decision === 'deny' || decision === 'reject'
          ? ({ decision } as const)
          : undefined;
    // Keep Bureau's authentication and schema error for incomplete or invalid CLI input.
    if (taskId === undefined || responseChoice === undefined) {
      return rpc(target, parsed, dependencies, 'bureau.tasks.respond', {
        taskId,
        ...response,
        ...(answer === undefined ? { decision } : { answer }),
      });
    }
    return catalogCall(target, parsed, dependencies, 'bureau.tasks.respond', {
      taskId,
      ...response,
      ...responseChoice,
    });
  }
  throw Object.assign(new Error('Usage: reviews list|get|approve|reject or runs respond.'), {
    usage: true,
  });
}
