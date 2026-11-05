import type { BatchOperation, ConditionalBatchCondition } from '@lostgradient/storage';

import { KEYS } from '../../storage/keys.ts';
import { decode, encode } from '../codec.ts';
import type { ContextOperationRequest } from '../context.ts';
import { EventLog, type EventHeadRecord } from '../event-log.ts';
import type { EngineInternals } from './internals.ts';

const FILE_WORKFLOW_TAG = 'file-workflow';

type FileWorkflowEvent = Readonly<{ type: string; payload: Record<string, unknown> }>;

type PreparedTerminalHistory = Readonly<{
  append: (operations: BatchOperation[]) => EventHeadRecord;
  head: () => EventHeadRecord;
  condition: () => ConditionalBatchCondition;
}>;

function isTaggedFileWorkflow(definition: unknown): boolean {
  if (typeof definition !== 'object' || definition === null || !('tags' in definition)) {
    return false;
  }
  return Array.isArray(definition.tags) && definition.tags.includes(FILE_WORKFLOW_TAG);
}

async function workflowIdentity(
  internals: EngineInternals,
  workflowId: string,
): Promise<{ type: string; revision: string | undefined } | undefined> {
  const cached = internals.workflowTypeByWorkflowId?.get(workflowId);
  if (cached !== undefined) return cached;
  const bytes = await internals.storage.get(KEYS.workflow(workflowId));
  if (bytes === null) return undefined;
  const state = decode(bytes) as { type?: string; revision?: string };
  return state.type === undefined ? undefined : { type: state.type, revision: state.revision };
}

function fileWorkflowDefinition(
  internals: EngineInternals,
  identity: { type: string; revision?: string | undefined },
) {
  const resolved = internals.sources.resolved.get(identity.type);
  if (identity.revision !== undefined) {
    const exact = resolved?.get(identity.revision);
    if (exact !== undefined) return exact.definition;
    if (resolved !== undefined) return undefined;
  }
  if (resolved?.size === 1) return [...resolved.values()][0]?.definition;
  return internals.workflowDefinitionsByName.get(identity.type);
}

async function isFileWorkflow(internals: EngineInternals, workflowId: string): Promise<boolean> {
  const identity = await workflowIdentity(internals, workflowId);
  return (
    identity !== undefined && isTaggedFileWorkflow(fileWorkflowDefinition(internals, identity))
  );
}

function eventKey(event: FileWorkflowEvent): string {
  if (event.type === 'file-workflow:run-terminal') return event.type;
  return `${event.type}:${String(event.payload['step'])}`;
}

function stepKind(
  operation: ContextOperationRequest,
): 'activity' | 'await-signal' | 'sleep' | undefined {
  const kinds: Record<
    ContextOperationRequest['type'],
    'activity' | 'await-signal' | 'sleep' | undefined
  > = {
    activity: 'activity',
    'wait-signal': 'await-signal',
    sleep: 'sleep',
    'wait-update': undefined,
  } as Record<ContextOperationRequest['type'], 'activity' | 'await-signal' | 'sleep' | undefined>;
  return kinds[operation.type];
}

function stepIndex(operation: ContextOperationRequest, fallback: number): number {
  return operation.type === 'activity' && operation.step !== undefined ? operation.step : fallback;
}

async function existingFileWorkflowEvents(
  internals: EngineInternals,
  workflowId: string,
  initialHead: EventHeadRecord,
): Promise<Set<string>> {
  const keys = new Set<string>();
  const log = new EventLog(internals.storage, workflowId, internals.options.getNow);
  for await (const entry of log.scan({ fromSequence: Math.max(0, initialHead.sequence - 8) })) {
    if (entry.type.startsWith('file-workflow:')) {
      keys.add(eventKey({ type: entry.type, payload: entry.payload as Record<string, unknown> }));
    }
  }
  return keys;
}

function appendEvents(
  internals: EngineInternals,
  workflowId: string,
  operations: BatchOperation[],
  events: readonly FileWorkflowEvent[],
  existing: ReadonlySet<string>,
  initialHead: EventHeadRecord,
): EventHeadRecord {
  const log = new EventLog(internals.storage, workflowId, internals.options.getNow);
  let head = initialHead;
  const appended = new Set<string>();
  for (const event of events) {
    const key = eventKey(event);
    if (existing.has(key) || appended.has(key)) continue;
    head = log.appendToBatch(event, operations, head).newHead;
    appended.add(key);
  }
  return head;
}

function completionEvents(
  pending:
    | { operationType: string; operationLabel: string; stepIndex?: number; status: string }
    | undefined,
): FileWorkflowEvent[] {
  if (pending?.status !== 'completed') return [];
  const step = pending.stepIndex ?? 0;
  const events: Record<string, FileWorkflowEvent[]> = {
    activity: [
      {
        type: 'file-workflow:activity-completed',
        payload: { step, handler: pending.operationLabel },
      },
      { type: 'file-workflow:step-completed', payload: { step, kind: 'activity' } },
    ],
    'wait-signal': [
      {
        type: 'file-workflow:signal-received',
        payload: { step, signal: pending.operationLabel },
      },
      { type: 'file-workflow:step-completed', payload: { step, kind: 'await-signal' } },
    ],
    sleep: [{ type: 'file-workflow:step-completed', payload: { step, kind: 'sleep' } }],
  };
  return events[pending.operationType] ?? [];
}

function startEvents(operation: ContextOperationRequest, step: number): FileWorkflowEvent[] {
  const kind = stepKind(operation);
  if (kind === undefined) return [];
  const events: FileWorkflowEvent[] = [
    { type: 'file-workflow:step-started', payload: { step, kind } },
  ];
  if (kind === 'activity') {
    events.push({
      type: 'file-workflow:activity-started',
      payload: { step, handler: operation.type === 'activity' ? operation.activityName : '' },
    });
  } else if (kind === 'await-signal') {
    events.push({
      type: 'file-workflow:signal-waiting',
      payload: { step, signal: operation.type === 'wait-signal' ? operation.signalName : '' },
    });
  }
  return events;
}

export async function appendFileWorkflowCheckpointEvents(
  internals: EngineInternals,
  workflowId: string,
  operation: ContextOperationRequest,
  pendingStepIndex: number,
  operations: BatchOperation[],
  initialHead: EventHeadRecord,
): Promise<EventHeadRecord> {
  if (!(await isFileWorkflow(internals, workflowId))) return initialHead;
  const existing = await existingFileWorkflowEvents(internals, workflowId, initialHead);
  const pending = internals.pendingTimelineEntries.get(workflowId)?.entry;
  const events = [
    ...completionEvents(pending),
    ...startEvents(operation, stepIndex(operation, pendingStepIndex)),
  ];
  return appendEvents(internals, workflowId, operations, events, existing, initialHead);
}

export async function prepareFileWorkflowTerminalHistory(
  internals: EngineInternals,
  workflowId: string,
  status: 'completed' | 'failed' | 'cancelled' | 'timed-out',
): Promise<PreparedTerminalHistory | undefined> {
  if (!(await isFileWorkflow(internals, workflowId))) return undefined;
  const initialHead =
    internals.eventLogHeads.get(workflowId) ??
    (await new EventLog(internals.storage, workflowId, internals.options.getNow).loadHead());
  const existing = await existingFileWorkflowEvents(internals, workflowId, initialHead);
  const pending = internals.pendingTimelineEntries.get(workflowId)?.entry;
  const terminal: FileWorkflowEvent = {
    type: 'file-workflow:run-terminal',
    payload: {
      status,
      ...(status === 'failed' ? { message: 'Workflow run failed.' } : {}),
      ...(status === 'timed-out' ? { message: 'Workflow run timed out.' } : {}),
    },
  };
  const events = [...completionEvents(pending), terminal];
  let lastHead = initialHead;
  return {
    append: (operations) => {
      lastHead = appendEvents(internals, workflowId, operations, events, existing, initialHead);
      return lastHead;
    },
    head: () => lastHead,
    condition: () => ({
      key: KEYS.eventHead(workflowId),
      expectedValue: initialHead.sequence < 0 ? null : encode(initialHead),
    }),
  };
}

export function recordFileWorkflowTerminalHistory(
  internals: EngineInternals,
  workflowId: string,
  prepared: PreparedTerminalHistory | undefined,
): void {
  if (prepared !== undefined) internals.eventLogHeads.set(workflowId, prepared.head());
}

export function fileWorkflowTerminalOperations(
  prepared: PreparedTerminalHistory | undefined,
): BatchOperation[] {
  const operations: BatchOperation[] = [];
  prepared?.append(operations);
  return operations;
}

export async function fileWorkflowHistoryHeadChanged(
  internals: EngineInternals,
  workflowId: string,
  prepared: PreparedTerminalHistory,
): Promise<boolean> {
  const current = await new EventLog(
    internals.storage,
    workflowId,
    internals.options.getNow,
  ).loadHead();
  return (
    current.sequence !== prepared.head().sequence || current.lastHash !== prepared.head().lastHash
  );
}

export async function shouldRetryFileWorkflowTermination(
  internals: EngineInternals,
  workflowId: string,
  prepared: PreparedTerminalHistory | undefined,
  attempt: number,
): Promise<boolean> {
  return prepared !== undefined && attempt < 10
    ? fileWorkflowHistoryHeadChanged(internals, workflowId, prepared)
    : false;
}
