/**
 * Where a task came from (COR-1867): the origin a task's record keeps from the moment it is
 * admitted, the Weft tag that mirrors it on the run's start, and the checks that read it back.
 *
 * An origin is a discriminated union on `kind`. A kind is added by adding a variant to
 * {@link TaskOrigin}, its name to {@link TASK_ORIGIN_KINDS}, and its check to the table behind
 * {@link isTaskOrigin}. The stored record is read by a looser rule than the one the view applies
 * ({@link isStoredTaskOrigin}): an origin of a kind this release does not know, or of a known
 * kind with a field it cannot read, leaves the record readable, so a release that does not know
 * a kind can still settle, list, and remove a task that a newer release (sharing the storage)
 * recorded with it. The view shows such an origin as `null`; the wire union stays closed.
 *
 * @module task-origin
 */

/** Every kind of origin a task record can carry, in the order they are listed on the wire. */
export const TASK_ORIGIN_KINDS = ['chat', 'person', 'schedule', 'api'] as const;

/** The kind of a {@link TaskOrigin}: what `bureau.tasks.list` filters by. */
export type TaskOriginKind = (typeof TASK_ORIGIN_KINDS)[number];

/** Where a person started a task from: the web app, its command palette, or an API call. */
export const TASK_PERSON_SURFACES = ['web', 'palette', 'api'] as const;

/** A surface a person started a task from. See {@link TASK_PERSON_SURFACES}. */
export type TaskPersonSurface = (typeof TASK_PERSON_SURFACES)[number];

/** A person's message in a chat started the task. */
export interface ChatTaskOrigin {
  /** Discriminant. */
  readonly kind: 'chat';
  /** The context (session) the chat message was sent in. */
  readonly contextId: string;
  /** The agent the chat is with. */
  readonly agentName: string;
  /** The principal that sent the message. */
  readonly principal: string;
}

/** A person started the task directly, outside a chat. */
export interface PersonTaskOrigin {
  /** Discriminant. */
  readonly kind: 'person';
  /** The principal that started the task. */
  readonly principal: string;
  /** Where the person started it from. */
  readonly surface: TaskPersonSurface;
}

/** One fire of a schedule started the task. */
export interface ScheduleTaskOrigin {
  /** Discriminant. */
  readonly kind: 'schedule';
  /** The schedule that fired. */
  readonly scheduleId: string;
  /** The fire: the run id the schedule's fire was given. */
  readonly fireId: string;
  /** Present and `true` when a person fired the schedule by hand instead of its cadence. */
  readonly manual?: true | undefined;
}

/**
 * The task was started through the API, or by something that has no Bureau context to name: a
 * start that did not say where it came from, a recovered run, or an A2A peer's message.
 */
export interface ApiTaskOrigin {
  /** Discriminant. */
  readonly kind: 'api';
}

/** Where a task came from. */
export type TaskOrigin = ChatTaskOrigin | PersonTaskOrigin | ScheduleTaskOrigin | ApiTaskOrigin;

/**
 * What a caller of `bureau.tasks.start` may declare about where a task came from. Only the kind
 * and what the Bureau cannot know are stated: the Bureau fills a chat's context, agent, and
 * principal from the authenticated start, so a caller cannot name another principal's chat. A
 * schedule's fire is the Bureau's own and cannot be declared. Omitted, the start is
 * `{ kind: 'api' }`.
 */
export type StartTaskOrigin =
  | { readonly kind: 'chat' }
  | { readonly kind: 'person'; readonly surface: TaskPersonSurface }
  | { readonly kind: 'api' };

/**
 * An origin as it may be stored: a `kind` this release does not know, or fields it cannot read.
 * It is kept as written and shown as `null` ({@link taskOriginView}).
 */
export interface UnrecognizedTaskOrigin {
  /** The kind as stored. */
  readonly kind: string;
  /** Whatever else was stored with it. */
  readonly [field: string]: unknown;
}

/** An origin as a task record stores it. See {@link UnrecognizedTaskOrigin}. */
export type StoredTaskOrigin = TaskOrigin | UnrecognizedTaskOrigin;

function isRecordOf(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPersonSurface(value: unknown): value is TaskPersonSurface {
  return (TASK_PERSON_SURFACES as readonly unknown[]).includes(value);
}

/** The check each kind's stored fields must pass. A field a kind does not name is ignored. */
const ORIGIN_CHECKS: Readonly<
  Record<TaskOriginKind, (value: Readonly<Record<string, unknown>>) => boolean>
> = {
  chat: (value) =>
    isNonEmptyString(value['contextId']) &&
    isNonEmptyString(value['agentName']) &&
    isNonEmptyString(value['principal']),
  person: (value) => isNonEmptyString(value['principal']) && isPersonSurface(value['surface']),
  schedule: (value) =>
    isNonEmptyString(value['scheduleId']) &&
    isNonEmptyString(value['fireId']) &&
    (value['manual'] === undefined || value['manual'] === true),
  api: () => true,
};

/** Whether a stored value is a task origin of a kind this version knows, in every field. */
export function isTaskOrigin(value: unknown): value is TaskOrigin {
  if (!isRecordOf(value)) return false;
  const kind = value['kind'];
  if (typeof kind !== 'string' || !Object.hasOwn(ORIGIN_CHECKS, kind)) return false;
  return ORIGIN_CHECKS[kind as TaskOriginKind](value);
}

/**
 * Whether a stored value is an origin a record may carry: an object with a non-empty string
 * `kind`. This is the one rule both sides share, the reader of a persisted record and the
 * admission that writes it, so nothing accepted on write is unreadable on read. It is looser than
 * {@link isTaskOrigin} on purpose: see the module comment.
 */
export function isStoredTaskOrigin(value: unknown): value is StoredTaskOrigin {
  return isRecordOf(value) && isNonEmptyString(value['kind']);
}

/** The origin a task's view shows: the stored one when this release can read it, else `null`. */
export function taskOriginView(stored: StoredTaskOrigin | undefined): TaskOrigin | null {
  return stored !== undefined && isTaskOrigin(stored) ? stored : null;
}

/** Whether `value` names a kind of origin. */
export function isTaskOriginKind(value: unknown): value is TaskOriginKind {
  return (TASK_ORIGIN_KINDS as readonly unknown[]).includes(value);
}

/**
 * Checks the origin a caller declared on a start, returning it, or `undefined` when none was
 * declared. Throws a `TypeError` naming the problem for anything else, so a start with a
 * misspelled origin is refused before a task exists.
 */
export function parseStartTaskOrigin(value: unknown): StartTaskOrigin | undefined {
  if (value === undefined) return undefined;
  if (!isRecordOf(value)) throw new TypeError('"options.origin" must be an object');
  const kind = value['kind'];
  if (kind === 'chat' || kind === 'api') return { kind };
  if (kind === 'person') {
    const surface = value['surface'];
    if (!isPersonSurface(surface)) {
      throw new TypeError(
        `"options.origin.surface" must be one of ${TASK_PERSON_SURFACES.join(', ')}`,
      );
    }
    return { kind, surface };
  }
  throw new TypeError('"options.origin.kind" must be one of chat, person, api');
}

/**
 * The Weft tag that mirrors an origin on the run's start: `origin:<kind>`. Weft lists runs by tag,
 * so the kind alone is mirrored; the identifiers live in the task's record.
 */
export function taskOriginTag(origin: Pick<TaskOrigin, 'kind'>): string {
  return `origin:${origin.kind}`;
}

/**
 * The origin a start records: the kind the caller declared, completed with what the start itself
 * resolved. A chat names the context, agent, and owner of this start, never ones the caller
 * stated; a person's principal is the owner. Undeclared, the origin is `{ kind: 'api' }`.
 */
export function taskOriginOfStart(
  declared: StartTaskOrigin | undefined,
  start: { readonly sessionId: string; readonly agentName: string; readonly owner: string },
): TaskOrigin {
  if (declared === undefined || declared.kind === 'api') return { kind: 'api' };
  if (declared.kind === 'person') {
    return { kind: 'person', principal: start.owner, surface: declared.surface };
  }
  return {
    kind: 'chat',
    contextId: start.sessionId,
    agentName: start.agentName,
    principal: start.owner,
  };
}
