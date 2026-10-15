import { sha256HexSync } from '@lostgradient/cryptography';
import {
  type ConditionalTextValueStore,
  encodeStorageKeyComponent,
  tryDecodeStorageKeyComponent,
} from '@lostgradient/weft';

import type { Effort, SteeringRequestedValue } from '@lostgradient/operative';

import type { ImplementedSteeringCommand, SteeringCommandAdmissionOutcome } from './steering';

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
      /**
       * The value the caller asked for, when Bureau resolved it to the
       * command's concrete one (a `policyRef`). Kept so an exact retry of the
       * original request matches even after the policy or catalog changes.
       */
      readonly submittedValue?: SteeringRequestedValue;
    }
  | {
      /**
       * Bureau refused the command before the gate saw it (an agent outside
       * the catalog, an unknown policy profile or coordinate). Logged so the
       * caller's id stays decided; the fold only records the refusal.
       */
      readonly type: 'refused';
      readonly command: ImplementedSteeringCommand;
      readonly outcome: Extract<
        SteeringCommandAdmissionOutcome,
        { outcome: 'rejected' | 'unsupported-capability' }
      >;
      readonly now: string;
      /** As on `admit`: the caller's value, when Bureau had already resolved it. */
      readonly submittedValue?: SteeringRequestedValue;
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
const EFFORTS = new Set<string>([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] satisfies readonly Effort[]);

/** Fails closed unless `value` is a complete, well-typed steering command. */
function isSteeringCommand(value: unknown): value is ImplementedSteeringCommand {
  if (!isRecord(value)) return false;
  const requested = value['requestedValue'];
  if (!isRecord(requested) || typeof requested['target'] !== 'string') return false;
  const target = requested['target'];
  const hasOneValue =
    (typeof requested['override'] === 'string' && requested['policyRef'] === undefined) ||
    (typeof requested['policyRef'] === 'string' && requested['override'] === undefined);
  // An effort override must be a real effort level; a corrupt one must not
  // reach provider selection.
  const effortIsValid =
    target !== 'effort' ||
    requested['override'] === undefined ||
    (typeof requested['override'] === 'string' && EFFORTS.has(requested['override']));
  // `pause`/`resume` carry no value at all; every other target exactly one.
  const valueShapeIsValid =
    target === 'pause' || target === 'resume'
      ? requested['override'] === undefined && requested['policyRef'] === undefined
      : (target === 'agent-identity' || CONFIGURATION_TARGETS.has(target)) &&
        hasOneValue &&
        effortIsValid;
  return (
    valueShapeIsValid &&
    typeof value['id'] === 'string' &&
    (value['idOrigin'] === 'caller' || value['idOrigin'] === 'generated') &&
    typeof value['sessionId'] === 'string' &&
    typeof value['principal'] === 'string' &&
    isTimestamp(value['requestedAt']) &&
    (value['expectedRevision'] === undefined || isVersion(value['expectedRevision'])) &&
    isOptionalString(value['deadline']) &&
    isOptionalString(value['runId'])
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const FAILURE_REASONS = new Set([
  'session-terminal',
  'run-terminal',
  'run-ambiguous',
  'authorization-revoked',
  'policy-denied',
  'deadline-passed',
]);

/** The complete `SteeringCommandFailure` union, `superseded-by` included. */
function isSteeringFailure(value: unknown): boolean {
  if (!isRecord(value) || !isTimestamp(value['failedAt'])) return false;
  if (value['reason'] === 'superseded-by') return typeof value['supersededBy'] === 'string';
  return (
    typeof value['reason'] === 'string' &&
    FAILURE_REASONS.has(value['reason']) &&
    value['supersededBy'] === undefined
  );
}

/**
 * A refusal Bureau decides before the gate: an unresolvable or uncatalogued
 * request (`policy-denied`), or an identity selector it cannot resolve
 * (`selector-unavailable`). Nothing else is ever logged as `refused`; any
 * other outcome would replay a decision no process made.
 */
function isRefusalOutcome(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value['outcome'] === 'unsupported-capability') {
    return value['reason'] === 'selector-unavailable';
  }
  return (
    value['outcome'] === 'rejected' &&
    isSteeringFailure(value['failure']) &&
    (value['failure'] as { reason: unknown }).reason === 'policy-denied'
  );
}

/**
 * Parses one entry of `sessionId`'s log. An admission or refusal whose
 * command names another session is corrupt: folding it would decide a
 * command against a session it was never submitted to.
 */
/**
 * A `submittedValue`, when present, is the selector Bureau resolved the
 * command's concrete value from: a valid requested value for the command,
 * with the same target, naming a `policyRef` and no override, while the
 * command itself carries the resolved override and no `policyRef`. Any
 * other pairing could make a retry of one value replay another's decision.
 */
function hasValidSubmittedValue(parsed: Record<string, unknown>): boolean {
  const submitted = parsed['submittedValue'];
  if (submitted === undefined) return true;
  const resolved = (parsed['command'] as { requestedValue: Record<string, unknown> })
    .requestedValue;
  return (
    isSteeringCommand({ ...(parsed['command'] as object), requestedValue: submitted }) &&
    isRecord(submitted) &&
    submitted['target'] === resolved['target'] &&
    typeof submitted['policyRef'] === 'string' &&
    submitted['override'] === undefined &&
    resolved['policyRef'] === undefined &&
    resolved['override'] !== undefined
  );
}

/**
 * `selector-unavailable` is refused for exactly one kind of command: an
 * `agent-identity` command naming a `policyRef`, which Bureau cannot yet
 * resolve. Paired with anything else, it is a decision no process made.
 */
function refusalFitsCommand(outcome: unknown, command: ImplementedSteeringCommand): boolean {
  if ((outcome as { outcome: unknown }).outcome !== 'unsupported-capability') return true;
  const requested = command.requestedValue as { target: string; policyRef?: unknown };
  return requested.target === 'agent-identity' && typeof requested.policyRef === 'string';
}

function parseEvent(raw: string, sequence: number, sessionId: string): SteeringLogEvent {
  const what = `Steering log entry ${String(sequence)}`;
  const parsed = parseJson(raw, what);
  if (isRecord(parsed) && isTimestamp(parsed['now'])) {
    switch (parsed['type']) {
      case 'admit': {
        const liveRunIds = parsed['liveRunIds'];
        if (
          isSteeringCommand(parsed['command']) &&
          parsed['command'].sessionId === sessionId &&
          // Admitted commands carry concrete values: Bureau resolves every
          // configuration selector first and refuses an identity selector
          // before the gate, logging that as `refused`.
          (parsed['command'].requestedValue as { policyRef?: unknown }).policyRef === undefined &&
          hasValidSubmittedValue(parsed) &&
          Array.isArray(liveRunIds) &&
          liveRunIds.every((runId) => typeof runId === 'string') &&
          // A set of runs: a repeated id would change its cardinality.
          new Set(liveRunIds).size === liveRunIds.length
        ) {
          return parsed as SteeringLogEvent;
        }
        break;
      }
      case 'refused':
        if (
          isSteeringCommand(parsed['command']) &&
          parsed['command'].sessionId === sessionId &&
          hasValidSubmittedValue(parsed) &&
          isRefusalOutcome(parsed['outcome']) &&
          refusalFitsCommand(parsed['outcome'], parsed['command'])
        ) {
          return parsed as SteeringLogEvent;
        }
        break;
      case 'applied':
        if (typeof parsed['runId'] === 'string' && isVersion(parsed['configVersion'])) {
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
    events.push(parseEvent(raw, sequence, sessionId));
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
    isVersion(parsed['sequence']) &&
    parsed['sequence'] > 0
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
 * Appends `event` immediately after `head`, atomically. An `admit` or
 * `refused` event also binds its `(principal, id)` key, provided the key's stored value is
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
  if (event.type === 'admit' || event.type === 'refused') {
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt binding is left for whoever reads it to fail closed on;
      // it must not stop the rest of this incarnation's cleanup.
      continue;
    }
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

/**
 * Every `(sessionId, incarnation)` with a steering log, read from the logs'
 * head keys. For the boot sweep that removes logs a crash left behind after
 * their session's deletion had already committed.
 */
export async function listSteeringLogIncarnations(
  kv: ConditionalTextValueStore,
): Promise<{ sessionId: string; incarnation: string }[]> {
  const found: { sessionId: string; incarnation: string }[] = [];
  for (const key of await kv.list(`${LOG_PREFIX}:`)) {
    if (!key.endsWith(':head')) continue;
    const [sessionPart, incarnationPart] = key
      .slice(LOG_PREFIX.length + 1, -':head'.length)
      .split(':');
    if (sessionPart === undefined || incarnationPart === undefined) continue;
    // A key no encoder wrote is skipped, so it cannot stop the sweep from
    // reaching every valid log after it.
    const sessionId = tryDecodeStorageKeyComponent(sessionPart);
    const incarnation = tryDecodeStorageKeyComponent(incarnationPart);
    if (sessionId === null || incarnation === null) continue;
    found.push({ sessionId, incarnation });
  }
  return found;
}

/**
 * The workflow tag a durable run of one session incarnation is launched
 * with, so durable steering can find that incarnation's live runs in every
 * process sharing the backend (`engine.list({ tags })`). Hashed, so any
 * session id fits Weft's per-tag size limit, and scoped to the incarnation,
 * so a deleted session's still-running workflows never count as live for a
 * session recreated under the same id.
 */
export function steeringSessionRunTag(sessionId: string, incarnation: string): string {
  // A JSON array, not a joined string: both parts are arbitrary strings, so
  // any separator could be forged by one of them.
  return `bureau-steering-run:${sha256HexSync(JSON.stringify([sessionId, incarnation])).slice(0, 40)}`;
}

/**
 * Whether `command` can be logged: exactly the shape the log parser accepts
 * when it reads the entry back. Anything else, once appended, would make the
 * whole session's log unreadable to every other process and every restart.
 */
export function isLoggableSteeringCommand(command: unknown): boolean {
  return isSteeringCommand(command);
}
