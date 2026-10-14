import { type ConditionalTextValueStore, encodeStorageKeyComponent } from '@lostgradient/weft';

import type { ImplementedSteeringCommand } from './steering';

/**
 * The durable steering log: one append-only log per session incarnation,
 * kept in `runtime.kv`, and the only durable record of steering. See
 * `documentation/durable-steering-log.md` for the design.
 *
 * A gate's state is a deterministic fold of its session's log. Every event
 * carries the process-local inputs the gate method it replays depends on —
 * the admitting process's live run ids and clock, a run's observed
 * `configVersion` — so any process folding the same log reaches the same
 * state, ledger, and command states, and `configVersion` continues across
 * restarts exactly where the previous process left it.
 *
 * Every append is one `conditionalBatch`: the entry and the new head,
 * conditioned on the head this process last read (optimistic concurrency,
 * no lease), plus — for an admission — the bureau-wide idempotency key,
 * conditioned on not existing. Nothing is ever consumed or acknowledged, so
 * there is no second store to fall out of step with.
 */

/** One logged steering event. */
export type SteeringLogEvent =
  | {
      /** `gate.admit(command, { liveRunIds, now })`, accepted or not. */
      readonly type: 'admit';
      readonly command: ImplementedSteeringCommand;
      readonly liveRunIds: readonly string[];
      readonly now: string;
    }
  | {
      /** `gate.recordApplied(runId, configVersion, now)`: a run observed a version at its boundary. */
      readonly type: 'applied';
      readonly runId: string;
      readonly configVersion: number;
      readonly now: string;
    }
  | {
      /** `gate.promoteForNewRun(runId, now)`: a run started on the session. */
      readonly type: 'promoted';
      readonly runId: string;
      readonly now: string;
    }
  | {
      /** `gate.failAcceptedForRun(runId, now)`: a run reached a terminal state. */
      readonly type: 'run-ended';
      readonly runId: string;
      readonly now: string;
    };

/** The log head as last read: its exact stored value (the append precondition) and sequence. */
export interface SteeringLogHead {
  readonly raw: string | null;
  readonly sequence: number;
}

/** Where a bureau-wide `(principal, id)` idempotency key was admitted. */
export interface SteeringKeyBinding {
  readonly sessionId: string;
  readonly incarnation: string;
  readonly sequence: number;
}

/** A binding as read: its exact stored value (a precondition to replace it) and contents. */
export interface StoredSteeringKeyBinding {
  readonly raw: string;
  readonly binding: SteeringKeyBinding;
}

/** Thrown when a stored head, entry, or key binding cannot be read as one. */
export class SteeringLogCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SteeringLogCorruptError';
  }
}

const LOG_PREFIX = 'steering-log:v1';
const KEY_PREFIX = 'steering-key:v1';
const SEQUENCE_WIDTH = 12;

function logPrefix(sessionId: string, incarnation: string): string {
  return `${LOG_PREFIX}:${encodeStorageKeyComponent(sessionId)}:${encodeStorageKeyComponent(incarnation)}:`;
}

function headKey(sessionId: string, incarnation: string): string {
  return `${logPrefix(sessionId, incarnation)}head`;
}

function entryKey(sessionId: string, incarnation: string, sequence: number): string {
  return `${logPrefix(sessionId, incarnation)}entry:${String(sequence).padStart(SEQUENCE_WIDTH, '0')}`;
}

/** Per-incarnation marker naming each key the log bound, so deletion can find them. */
function keyMarkerKey(
  sessionId: string,
  incarnation: string,
  principal: string,
  id: string,
): string {
  return `${logPrefix(sessionId, incarnation)}key:${encodeStorageKeyComponent(principal)}:${encodeStorageKeyComponent(id)}`;
}

function keyBindingKey(principal: string, id: string): string {
  return `${KEY_PREFIX}:${encodeStorageKeyComponent(principal)}:${encodeStorageKeyComponent(id)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function parseJson(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new SteeringLogCorruptError(`${what} is not valid JSON.`);
  }
}

const CONFIGURATION_TARGETS = new Set(['route', 'model', 'provider', 'effort']);

/** Fails closed unless `value` is a complete, well-typed steering command. */
function isSteeringCommand(value: unknown): value is ImplementedSteeringCommand {
  if (!isRecord(value)) return false;
  const requested = value['requestedValue'];
  if (!isRecord(requested) || typeof requested['target'] !== 'string') return false;
  const target = requested['target'];
  const valueShapeIsValid =
    target === 'pause' || target === 'resume'
      ? true
      : (target === 'agent-identity' || CONFIGURATION_TARGETS.has(target)) &&
        typeof requested['override'] === 'string';
  return (
    valueShapeIsValid &&
    typeof value['id'] === 'string' &&
    (value['idOrigin'] === 'caller' || value['idOrigin'] === 'generated') &&
    typeof value['sessionId'] === 'string' &&
    typeof value['principal'] === 'string' &&
    typeof value['requestedAt'] === 'string' &&
    (value['expectedRevision'] === undefined || typeof value['expectedRevision'] === 'number') &&
    isOptionalString(value['deadline']) &&
    isOptionalString(value['runId'])
  );
}

function parseEvent(raw: string, sequence: number): SteeringLogEvent {
  const what = `Steering log entry ${String(sequence)}`;
  const parsed = parseJson(raw, what);
  if (isRecord(parsed) && typeof parsed['now'] === 'string') {
    switch (parsed['type']) {
      case 'admit': {
        const liveRunIds = parsed['liveRunIds'];
        if (
          isSteeringCommand(parsed['command']) &&
          Array.isArray(liveRunIds) &&
          liveRunIds.every((runId) => typeof runId === 'string')
        ) {
          return parsed as SteeringLogEvent;
        }
        break;
      }
      case 'applied':
        if (typeof parsed['runId'] === 'string' && typeof parsed['configVersion'] === 'number') {
          return parsed as SteeringLogEvent;
        }
        break;
      case 'promoted':
      case 'run-ended':
        if (typeof parsed['runId'] === 'string') return parsed as SteeringLogEvent;
        break;
    }
  }
  throw new SteeringLogCorruptError(`${what} is malformed.`);
}

/** Reads a session incarnation's log head; an absent head is an empty log. */
export async function readSteeringLogHead(
  kv: ConditionalTextValueStore,
  sessionId: string,
  incarnation: string,
): Promise<SteeringLogHead> {
  const raw = await kv.get(headKey(sessionId, incarnation));
  if (raw === null) return { raw, sequence: 0 };
  const parsed = parseJson(raw, `Steering log head for session "${sessionId}"`);
  const sequence = isRecord(parsed) ? parsed['sequence'] : undefined;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new SteeringLogCorruptError(`Steering log head for session "${sessionId}" is malformed.`);
  }
  return { raw, sequence };
}

/**
 * Reads entries `after + 1` through `through`, in order. A missing entry
 * inside the head's range is corruption, not an empty slot.
 */
export async function readSteeringLogEntries(
  kv: ConditionalTextValueStore,
  sessionId: string,
  incarnation: string,
  after: number,
  through: number,
): Promise<SteeringLogEvent[]> {
  const events: SteeringLogEvent[] = [];
  for (let sequence = after + 1; sequence <= through; sequence += 1) {
    const raw = await kv.get(entryKey(sessionId, incarnation, sequence));
    if (raw === null) {
      throw new SteeringLogCorruptError(
        `Steering log entry ${String(sequence)} for session "${sessionId}" is missing.`,
      );
    }
    events.push(parseEvent(raw, sequence));
  }
  return events;
}

/** Reads the binding for a bureau-wide `(principal, id)` key, if any. */
export async function readSteeringKeyBinding(
  kv: ConditionalTextValueStore,
  principal: string,
  id: string,
): Promise<StoredSteeringKeyBinding | undefined> {
  const raw = await kv.get(keyBindingKey(principal, id));
  if (raw === null) return undefined;
  const parsed = parseJson(raw, `Steering key binding for "${principal}"/"${id}"`);
  if (
    isRecord(parsed) &&
    typeof parsed['sessionId'] === 'string' &&
    typeof parsed['incarnation'] === 'string' &&
    typeof parsed['sequence'] === 'number'
  ) {
    return { raw, binding: parsed as unknown as SteeringKeyBinding };
  }
  throw new SteeringLogCorruptError(
    `Steering key binding for "${principal}"/"${id}" is malformed.`,
  );
}

export type SteeringLogAppendResult =
  /** `head` is the head this append wrote: the cursor for exactly what has been applied. */
  | { readonly status: 'appended'; readonly head: SteeringLogHead }
  /** Another process appended first; catch up and decide again. */
  | { readonly status: 'head-moved' }
  /** The idempotency key was bound (or rebound) concurrently; read it again. */
  | { readonly status: 'key-taken' };

/**
 * Appends `event` immediately after `head`, atomically. An `admit` event
 * also binds its `(principal, id)` key, provided the key's stored value is
 * still `expectedBinding` (`null` for unbound, or a stale binding being
 * replaced).
 */
export async function appendSteeringLogEvent(
  kv: ConditionalTextValueStore,
  sessionId: string,
  incarnation: string,
  head: SteeringLogHead,
  event: SteeringLogEvent,
  expectedBinding: string | null = null,
): Promise<SteeringLogAppendResult> {
  const sequence = head.sequence + 1;
  const nextHead = JSON.stringify({ sequence });
  const conditions: { key: string; expectedValue: string | null }[] = [
    { key: headKey(sessionId, incarnation), expectedValue: head.raw },
  ];
  const operations: { type: 'set'; key: string; value: string }[] = [
    { type: 'set', key: entryKey(sessionId, incarnation, sequence), value: JSON.stringify(event) },
    { type: 'set', key: headKey(sessionId, incarnation), value: nextHead },
  ];
  if (event.type === 'admit') {
    const { principal, id } = event.command;
    const bindingKey = keyBindingKey(principal, id);
    conditions.push({ key: bindingKey, expectedValue: expectedBinding });
    operations.push(
      {
        type: 'set',
        key: bindingKey,
        value: JSON.stringify({ sessionId, incarnation, sequence } satisfies SteeringKeyBinding),
      },
      { type: 'set', key: keyMarkerKey(sessionId, incarnation, principal, id), value: bindingKey },
    );
  }
  if (await kv.conditionalBatch(conditions, operations)) {
    return { status: 'appended', head: { raw: nextHead, sequence } };
  }
  const current = await kv.get(headKey(sessionId, incarnation));
  return current === head.raw ? { status: 'key-taken' } : { status: 'head-moved' };
}

/**
 * Deletes one session incarnation's log and every idempotency key it bound.
 * A key is deleted only while it still points at this incarnation, so a key
 * a newer session has since rebound survives.
 */
export async function deleteSteeringLog(
  kv: ConditionalTextValueStore,
  sessionId: string,
  incarnation: string,
): Promise<void> {
  const prefix = logPrefix(sessionId, incarnation);
  for (const markerKey of await kv.list(`${prefix}key:`)) {
    const bindingKey = await kv.get(markerKey);
    if (bindingKey === null) continue;
    const raw = await kv.get(bindingKey);
    if (raw === null) continue;
    const parsed = parseJson(raw, 'Steering key binding');
    if (
      isRecord(parsed) &&
      parsed['sessionId'] === sessionId &&
      parsed['incarnation'] === incarnation
    ) {
      await kv.conditionalBatch(
        [{ key: bindingKey, expectedValue: raw }],
        [{ type: 'delete', key: bindingKey }],
      );
    }
  }
  await kv.deletePrefix(prefix);
}
