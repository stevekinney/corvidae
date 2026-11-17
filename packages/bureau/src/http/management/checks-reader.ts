/**
 * Reads the results of every check Bureau keeps, newest first, for `bureau.checks.list` (COR-2113).
 *
 * A check result lives in one of three places. A guardrail that blocked, redacted or tripped a run,
 * and a scorer's score of a run (COR-2252), are records of the audit trail (`run.guardrail`,
 * `run.tripwire`, `scorer.recorded`). A goal's validator verdict is the
 * validation of an attempt in the goal store. A session a guardrail flagged carries
 * `guardrailTaint` in its metadata (COR-2105, COR-2116), which is read from the session store and
 * not from the event feed, which is not durable. This reader merges the three, in one order,
 * behind one cursor.
 *
 * What a row carries is chosen field by field from each source: the check, the agent, the outcome,
 * the time and the run, and for a scorer its score. Never read here, so never on a row: the text a
 * guardrail flagged and its `detail`, a validator's feedback and evidence, and a scorer's `message`.
 *
 * The order is total. Rows sort by time, newest first; at one millisecond a run row (trail) comes
 * before a goal row, which comes before a session row; within a source the key decides, largest
 * first (a trail record's sequence, a goal's id then its attempt index, a session's id). A cursor is
 * the position of the last row of a page in that order, so a page continues exactly after it and
 * every row appears once, whichever sources its neighbours came from.
 *
 * @module checks-reader
 */

import { readSessionTaint, type SessionStore, type SessionSummary } from '@lostgradient/operative';

import type { AuditRecord, AuditTrail } from '../../audit-trail.ts';
import type { GoalState } from '../../goal-state.ts';
import type { BureauGoalListOptions } from '../../goal-types.ts';

/** Where a check result is kept. */
export const CHECK_KINDS = [
  'goal.attempt.validated',
  'run.guardrail',
  'run.tripwire',
  'scorer.recorded',
  'session.tainted',
] as const;

/** One of {@link CHECK_KINDS}. */
export type CheckKind = (typeof CHECK_KINDS)[number];

/** What a validator or a scorer decided: the kinds of a `ValidatorOutcome`. */
const VERDICT_OUTCOMES = [
  'pass',
  'fail',
  'error',
  'unavailable',
  'canceled',
  'indeterminate',
] as const;

/** What a validate-mode guardrail did. */
const GUARDRAIL_OUTCOMES = ['block', 'warn', 'sanitize', 'redact'] as const;

/** Every outcome a row can carry. */
export const CHECK_OUTCOMES = [
  ...VERDICT_OUTCOMES,
  ...GUARDRAIL_OUTCOMES,
  'tripwire',
  'tainted',
] as const;

/** One of {@link CHECK_OUTCOMES}. */
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

/** The most characters a check id or an agent name has on a row, and in a filter. */
export const CHECK_TEXT_LIMIT = 256;

/** How many rows a page holds when none is asked for. */
export const DEFAULT_CHECKS_PAGE_LIMIT = 50;

/** The most rows one page may hold. */
export const MAXIMUM_CHECKS_PAGE_LIMIT = 100;

/** The longest cursor this reader accepts; the longest one it writes is a goal id and a few digits. */
export const MAXIMUM_CHECKS_CURSOR_LENGTH = 1024;

/** How many trail records one read asks for. */
const SCAN_CHUNK = 200;

/** How many sessions one read of the store asks for. */
const SESSION_PAGE = 100;

/** One check result. */
export type CheckRow = {
  readonly kind: CheckKind;
  /** `validator@version` or `scorer@version`, a guardrail's name, or a session's detector. */
  readonly checkId: string;
  /** The agent the check judged, or `null` when it cannot be told. */
  readonly agentName: string | null;
  readonly outcome: CheckOutcome;
  /** ISO-8601. */
  readonly timestamp: string;
  readonly runId: string;
  /** The goal a goal check judged, or `null`. */
  readonly goalRunId: string | null;
  /** The goal attempt a goal check judged, or `null`. */
  readonly attemptId: string | null;
  /** A scorer's score, a finite number from 0 to 1 when it gave one; `null` for every other row. */
  readonly score: number | null;
};

/** What narrows a read. Every field is optional; a row must match all that are set. */
export type ChecksFilter = {
  readonly kind?: CheckKind | undefined;
  readonly checkId?: string | undefined;
  readonly agentName?: string | undefined;
  readonly outcome?: CheckOutcome | undefined;
  /** Epoch milliseconds, inclusive. */
  readonly since?: number | undefined;
  /** Epoch milliseconds, inclusive. */
  readonly until?: number | undefined;
};

/** Who may see what: the caller's owner, and which scopes widen it to every owner. */
export type ChecksScope = {
  /** The owner the caller owns resources as, or `undefined` when it owns none. */
  readonly caller: string | undefined;
  /** `bureau.audit:read`: every owner's run rows and flagged sessions. */
  readonly everyRunOwner: boolean;
  /** `bureau.goals:read`: every owner's goal rows. */
  readonly everyGoalOwner: boolean;
};

/** What the reader reads from. */
export type ChecksSources = {
  /** The audit trail, or `undefined` for a Bureau that keeps none. */
  readonly trail: () => Pick<AuditTrail, 'query'> | undefined;
  /** The owner of record of the resource a trail record is about. */
  readonly ownerOfRecord: (
    record: Pick<AuditRecord, 'runId' | 'detail'>,
  ) => Promise<string | undefined>;
  /** The goal store; `principal` narrows to one owner, and omitted is every owner's. */
  readonly goals: { readonly list: (options?: BureauGoalListOptions) => Promise<GoalState[]> };
  /** The session store, or `undefined` when the Bureau keeps none. */
  readonly sessions: () => Pick<SessionStore, 'list'> | undefined;
};

/** One page. */
export type ChecksPage = {
  readonly checks: readonly CheckRow[];
  /** Pass it as `cursor` for the next page; `null` on the last. */
  readonly nextCursor: string | null;
};

type Source = 'run' | 'goal' | 'session';

/** What orders a row inside its source, largest first. */
type SourceKey = number | readonly [string, number] | string;

/** A row's place in the one order: its time, its source, and its key in that source. */
type Position = readonly [timestampMs: number, source: Source, key: SourceKey];

type Candidate = { readonly row: CheckRow; readonly position: Position };

const SOURCE_RANK: Readonly<Record<Source, number>> = { run: 0, goal: 1, session: 2 };

function compareKeys(first: SourceKey, second: SourceKey): number {
  if (typeof first === 'number' && typeof second === 'number') return second - first;
  if (typeof first === 'string' && typeof second === 'string') {
    return first < second ? 1 : first > second ? -1 : 0;
  }
  if (Array.isArray(first) && Array.isArray(second)) {
    const [firstId, firstIndex] = first as readonly [string, number];
    const [secondId, secondIndex] = second as readonly [string, number];
    if (firstId !== secondId) return firstId < secondId ? 1 : -1;
    return secondIndex - firstIndex;
  }
  return 0;
}

/** Negative when `first` comes before `second` in the order, positive when after. */
function comparePositions(first: Position, second: Position): number {
  if (first[0] !== second[0]) return second[0] - first[0];
  if (first[1] !== second[1]) return SOURCE_RANK[first[1]] - SOURCE_RANK[second[1]];
  return compareKeys(first[2], second[2]);
}

/** Write a position as a cursor. */
export function encodeChecksCursor(position: Position): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url');
}

function isKeyOf(source: Source, key: unknown): key is SourceKey {
  if (source === 'run') return typeof key === 'number' && Number.isSafeInteger(key);
  if (source === 'session') return typeof key === 'string' && key.length > 0;
  return (
    Array.isArray(key) &&
    key.length === 2 &&
    typeof key[0] === 'string' &&
    key[0].length > 0 &&
    typeof key[1] === 'number' &&
    Number.isSafeInteger(key[1]) &&
    key[1] >= 0
  );
}

/**
 * The position a cursor names, or `undefined` for a string this reader did not write. A cursor is
 * accepted only when writing the position it decodes to gives the same string back, so there is one
 * spelling of each position.
 */
export function decodeChecksCursor(cursor: string): Position | undefined {
  if (cursor.length === 0 || cursor.length > MAXIMUM_CHECKS_CURSOR_LENGTH) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return undefined;
  const [timestampMs, source, key] = parsed as [unknown, unknown, unknown];
  if (typeof timestampMs !== 'number' || !Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    return undefined;
  }
  if (source !== 'run' && source !== 'goal' && source !== 'session') return undefined;
  if (!isKeyOf(source, key)) return undefined;
  const position: Position = [timestampMs, source, key];
  return encodeChecksCursor(position) === cursor ? position : undefined;
}

/** A non-empty string cut to the row's limit, or `undefined` for anything else. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, CHECK_TEXT_LIMIT)
    : undefined;
}

function detailOf(record: AuditRecord): Readonly<Record<string, unknown>> {
  return typeof record.detail === 'object' && record.detail !== null
    ? (record.detail as Readonly<Record<string, unknown>>)
    : {};
}

function readOutcome<Allowed extends string>(
  value: unknown,
  allowed: readonly Allowed[],
): Allowed | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as Allowed)
    : undefined;
}

/** The row a trail record is, or `undefined` for one that is not a check or is not well formed. */
function runRowOf(record: AuditRecord): CheckRow | undefined {
  const detail = detailOf(record);
  const timestamp = new Date(record.timestampMs).toISOString();
  if (record.type === 'run.guardrail' || record.type === 'run.tripwire') {
    const checkId = textOf(detail['guardrailName']);
    const outcome =
      record.type === 'run.tripwire'
        ? 'tripwire'
        : readOutcome(detail['action'], GUARDRAIL_OUTCOMES);
    if (checkId === undefined || outcome === undefined) return undefined;
    return {
      kind: record.type,
      checkId,
      agentName: null,
      outcome,
      timestamp,
      runId: record.runId,
      goalRunId: null,
      attemptId: null,
      score: null,
    };
  }
  if (record.type === 'scorer.recorded') {
    // The scorer's `message` is on this record and is never read here.
    const name = textOf(detail['judgeName']);
    const version = textOf(detail['judgeVersion']);
    const outcome = readOutcome(detail['outcome'], VERDICT_OUTCOMES);
    if (name === undefined || version === undefined || outcome === undefined) return undefined;
    const score = detail['score'];
    return {
      kind: 'scorer.recorded',
      checkId: `${name}@${version}`.slice(0, CHECK_TEXT_LIMIT),
      agentName: textOf(detail['definitionId']) ?? null,
      outcome,
      timestamp,
      runId: record.runId,
      goalRunId: null,
      attemptId: null,
      score: typeof score === 'number' && Number.isFinite(score) ? score : null,
    };
  }
  return undefined;
}

function matches(row: CheckRow, timestampMs: number, filter: ChecksFilter): boolean {
  if (filter.kind !== undefined && row.kind !== filter.kind) return false;
  if (filter.checkId !== undefined && row.checkId !== filter.checkId) return false;
  if (filter.outcome !== undefined && row.outcome !== filter.outcome) return false;
  if (filter.since !== undefined && timestampMs < filter.since) return false;
  if (filter.until !== undefined && timestampMs > filter.until) return false;
  return true;
}

/** Which of the trail's types the filter asks for. */
function trailTypes(filter: ChecksFilter): ReadonlySet<string> {
  const all = ['run.guardrail', 'run.tripwire', 'scorer.recorded'];
  return new Set(filter.kind === undefined ? all : all.filter((type) => type === filter.kind));
}

/**
 * Merges streams that are each in the order, lazily: the next row is the first of the streams'
 * heads, and a stream is read again only once its head has been taken.
 */
async function* mergeInOrder(
  streams: readonly AsyncGenerator<Candidate>[],
): AsyncGenerator<Candidate> {
  try {
    const heads = await Promise.all(streams.map((stream) => stream.next()));
    for (;;) {
      let best = -1;
      for (const [index, head] of heads.entries()) {
        if (head.done === true) continue;
        const current = best === -1 ? undefined : heads[best];
        if (
          current === undefined ||
          current.done === true ||
          comparePositions(head.value.position, current.value.position) < 0
        ) {
          best = index;
        }
      }
      const winner = best === -1 ? undefined : heads[best];
      if (winner === undefined || winner.done === true) return;
      yield winner.value;
      heads[best] = await streams[best]!.next();
    }
  } finally {
    await Promise.all(streams.map((stream) => stream.return(undefined)));
  }
}

/**
 * One page of check results the caller may see, newest first.
 *
 * `cursor` is a position {@link decodeChecksCursor} accepted. A page is filled from the rows the
 * caller may see, and one more is read to know whether another page follows, so a cursor advances
 * across any number of rows the caller may not.
 */
export async function listChecks(
  sources: ChecksSources,
  scope: ChecksScope,
  filter: ChecksFilter,
  page: { readonly limit: number; readonly cursor?: Position | undefined },
): Promise<ChecksPage> {
  const { caller, everyRunOwner, everyGoalOwner } = scope;
  const after = page.cursor;
  const isAfterCursor = (position: Position): boolean =>
    after === undefined || comparePositions(after, position) < 0;
  const wants = (kind: CheckKind): boolean => filter.kind === undefined || filter.kind === kind;

  // Goals that name a run, read once and only when a trail row needs one: the agent of a run the
  // trail never saw start, and the owner of a goal attempt's run.
  let goalsByRun: Promise<Map<string, GoalState>> | undefined;
  const goalOfRun = async (runId: string): Promise<GoalState | undefined> => {
    goalsByRun ??= sources.goals.list().then((goals) => {
      const byRun = new Map<string, GoalState>();
      for (const goal of goals) {
        for (const attempt of goal.attempts) byRun.set(attempt.runId, goal);
      }
      return byRun;
    });
    const byRun = await goalsByRun;
    return byRun.get(runId);
  };

  const owners = new Map<string, string | undefined>();
  const mayReadRun = async (record: AuditRecord): Promise<boolean> => {
    if (everyRunOwner) return true;
    if (caller === undefined) return false;
    const cached = owners.has(record.runId);
    let owner = cached ? owners.get(record.runId) : await sources.ownerOfRecord(record);
    if (!cached) {
      if (owner === undefined) {
        const goal = await goalOfRun(record.runId);
        owner = goal?.principal;
      }
      owners.set(record.runId, owner);
    }
    return owner !== undefined && owner === caller;
  };

  const agents = new Map<string, string | null>();
  const agentOfRun = async (runId: string): Promise<string | null> => {
    const known = agents.get(runId);
    if (known !== undefined) return known;
    const started = await sources.trail()?.query({ runId, type: 'run.started', limit: 1 });
    const fromTrail = textOf(
      started?.[0] === undefined ? undefined : detailOf(started[0])['agentName'],
    );
    const goal = fromTrail === undefined ? await goalOfRun(runId) : undefined;
    const agent = fromTrail ?? textOf(goal?.objective.agentName) ?? null;
    agents.set(runId, agent);
    return agent;
  };

  async function* runStream(): AsyncGenerator<Candidate> {
    const trail = sources.trail();
    const types = trailTypes(filter);
    if (trail === undefined || types.size === 0) return;
    let before: { timestampMs: number; sequence: number } | undefined =
      after === undefined
        ? undefined
        : after[1] === 'run'
          ? { timestampMs: after[0], sequence: after[2] as number }
          : { timestampMs: after[0], sequence: -1 };
    for (;;) {
      const chunk = await trail.query({
        select: 'newest',
        ...(before === undefined ? {} : { before }),
        ...(filter.since === undefined ? {} : { since: filter.since }),
        filter: (record) =>
          types.has(record.type) &&
          (filter.until === undefined || record.timestampMs <= filter.until),
        limit: SCAN_CHUNK,
      });
      // The trail answers a chunk oldest first; a newest-first walk reads it backward.
      for (const record of chunk.toReversed()) {
        const sequence = record.sequence ?? -1;
        before = { timestampMs: record.timestampMs, sequence };
        const position: Position = [record.timestampMs, 'run', sequence];
        if (!isAfterCursor(position)) continue;
        const row = runRowOf(record);
        if (row === undefined || !matches(row, record.timestampMs, filter)) continue;
        if (!(await mayReadRun(record))) continue;
        const agentName = row.agentName ?? (await agentOfRun(record.runId));
        if (filter.agentName !== undefined && agentName !== filter.agentName) continue;
        yield { row: { ...row, agentName }, position };
      }
      if (chunk.length < SCAN_CHUNK) return;
    }
  }

  async function* goalStream(): AsyncGenerator<Candidate> {
    if (!wants('goal.attempt.validated')) return;
    if (!everyGoalOwner && caller === undefined) return;
    const goals = await sources.goals.list(everyGoalOwner ? {} : { principal: caller });
    const found: Candidate[] = [];
    for (const goal of goals) {
      for (const attempt of goal.attempts) {
        const validation = attempt.validation;
        if (validation === undefined) continue;
        const timestampMs = Date.parse(validation.completedAt);
        const outcome = readOutcome(validation.outcome.kind, VERDICT_OUTCOMES);
        const name = textOf(validation.identity.name);
        const version = textOf(validation.identity.version);
        if (Number.isNaN(timestampMs) || timestampMs < 0 || outcome === undefined) continue;
        if (name === undefined || version === undefined) continue;
        const row: CheckRow = {
          kind: 'goal.attempt.validated',
          checkId: `${name}@${version}`.slice(0, CHECK_TEXT_LIMIT),
          agentName: textOf(goal.objective.agentName) ?? null,
          outcome,
          timestamp: new Date(timestampMs).toISOString(),
          runId: attempt.runId,
          goalRunId: goal.goalRunId,
          attemptId: attempt.attemptId,
          score: null,
        };
        const position: Position = [
          Math.trunc(timestampMs),
          'goal',
          [goal.goalRunId, attempt.attemptIndex],
        ];
        if (!matches(row, timestampMs, filter) || !isAfterCursor(position)) continue;
        if (filter.agentName !== undefined && row.agentName !== filter.agentName) continue;
        found.push({ row, position });
      }
    }
    found.sort((first, second) => comparePositions(first.position, second.position));
    yield* found;
  }

  async function* sessionStream(): AsyncGenerator<Candidate> {
    if (!wants('session.tainted')) return;
    const store = sources.sessions();
    if (store === undefined || (!everyRunOwner && caller === undefined)) return;
    const found: Candidate[] = [];
    for (let offset = 0; ; offset += SESSION_PAGE) {
      const summaries: SessionSummary[] = await store.list({
        ...(everyRunOwner || caller === undefined ? {} : { owner: caller }),
        limit: SESSION_PAGE,
        offset,
      });
      for (const summary of summaries) {
        // Only the taint's detector and time are read: its category, provenance and confidence stay.
        const taint = readSessionTaint(summary.metadata);
        const checkId = textOf(taint?.detector);
        if (taint === undefined || checkId === undefined) continue;
        if (!Number.isSafeInteger(taint.at) || taint.at < 0) continue;
        const row: CheckRow = {
          kind: 'session.tainted',
          checkId,
          agentName: textOf(summary.agentName) ?? null,
          outcome: 'tainted',
          timestamp: new Date(taint.at).toISOString(),
          runId: taint.runId,
          goalRunId: null,
          attemptId: null,
          score: null,
        };
        const position: Position = [taint.at, 'session', summary.id];
        if (!matches(row, taint.at, filter) || !isAfterCursor(position)) continue;
        if (filter.agentName !== undefined && row.agentName !== filter.agentName) continue;
        found.push({ row, position });
      }
      if (summaries.length < SESSION_PAGE) break;
    }
    found.sort((first, second) => comparePositions(first.position, second.position));
    yield* found;
  }

  const merged = mergeInOrder([runStream(), goalStream(), sessionStream()]);
  const rows: Candidate[] = [];
  let more = false;
  for await (const candidate of merged) {
    // One more than the page: it is what says there is a next page.
    if (rows.length === page.limit) {
      more = true;
      break;
    }
    rows.push(candidate);
  }
  const last = rows.at(-1);
  return {
    checks: rows.map((candidate) => candidate.row),
    nextCursor: more && last !== undefined ? encodeChecksCursor(last.position) : null,
  };
}
