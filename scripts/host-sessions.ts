#!/usr/bin/env bun
/**
 * The host-wide cap on implementation workers and the coordinators that dispatch them (AGENTS.md
 * "Parallel runs", COR-2455), enforced by Claude Code hooks in `.claude/settings.json`.
 *
 * Each session that dispatches a place-taking agent ({@link placeTakingAgentTypes}) keeps a ledger
 * in the Git common directory, which every worktree shares: the session's own process (the nearest
 * `claude` ancestor of the hook, by pid and start time), and its hook events, each appended as the
 * next numbered file by one exclusive link, so a ledger has one order. `scripts/host-sessions-model.ts`
 * folds a ledger into the session's places: one for each admitted dispatch whose agent has not
 * started and one for each running agent, plus one for the session's coordinator while it has any.
 * The main agent and its subagents are one coordinator. Nothing is bound to a place.
 *
 * - `PreToolUse` on an `Agent` call of a place-taking type admits it when its places fit: one, or
 *   two when its session has no worker. Waiters are admitted oldest first among those whose need
 *   fits, so a waiter needing two never holds back a later one needing one. At the cap the hook
 *   waits, up to {@link placeWaitLimitMilliseconds}, then denies the call with the holders.
 *   Admission, its reclaims and its expiries run under one short lock, never held across a wait.
 * - `SubagentStart`, `SubagentStop`, `StopFailure`, `PostToolUse`, `PostToolUseFailure` and
 *   `PermissionDenied` are recorded in the ledger; the fold decides what they change.
 * - A ledger whose session process is gone, and an admitted dispatch with no start after
 *   {@link neverStartedLimitMilliseconds}, are reclaimed by the next admission.
 * - {@link capBypassVariable}, set in the session's environment to text a dispatch's description or
 *   prompt contains (its issue, say), admits that dispatch at once, past the cap, and says so.
 *
 * Usage: `bun scripts/host-sessions.ts status` lists the places and waiters;
 * `bun scripts/host-sessions.ts release <session, dispatch or agent>` frees a place by hand;
 * `bun scripts/host-sessions.ts hook` is the hook, reading its input from standard input.
 * `--directory=<path>` uses another places directory, for a check by hand.
 */

import { link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  isHolderAlive,
  readProcessTable,
  type ProcessEntry,
  type ProcessTable,
} from './bun-test-pool.ts';
import { rootScriptEnvironment } from './environment-configuration.ts';
import {
  applySessionEvent,
  foldSession,
  neverStarted,
  neverStartedLimitMilliseconds,
  runsWithoutAdmission,
  sessionPlaces,
  workerPlaces,
  type SessionEvent,
  type SessionState,
} from './host-sessions-model.ts';
import {
  ancestorsOf,
  enqueue,
  gitCommonDirectory,
  readOwner,
  readTicket,
  removeLock,
  tryInstall,
  type OwnerRecord,
} from './run-exclusively.ts';

/** How many places the host has: implementation workers and their coordinators together. */
export const hostPlaceCap = 3;

/** How long a dispatch waits for a place before it is denied. */
export const placeWaitLimitMilliseconds = 20 * 60 * 1000;

/** How often a waiting dispatch looks again. */
export const placePollIntervalMilliseconds = 5_000;

/** How often a hook looks again for the admission lock, which is held only while deciding. */
export const admissionLockRetryMilliseconds = 100;

/** Set to text in one dispatch's description or prompt to admit that dispatch past the cap. */
export const capBypassVariable = 'CORVIDAE_AGENT_CAP_BYPASS';

/** The agent types that take a place. Every other type, `chef-reviewer` and Explore among them, takes none. */
export const placeTakingAgentTypes: ReadonlySet<string> = new Set(['chef-worker']);

/** The places directory's name in the Git common directory. */
export const placesDirectoryName = 'corvidae-agent-places';

type ProcessIdentity = { readonly pid: number; readonly pidStartedAt?: string };

/** A session's ledger as read: its process, and its events folded. */
export type SessionLedger = {
  readonly sessionId: string;
  readonly directory: string;
  /** The session's process; absent when its ledger has none recorded yet. */
  readonly holder?: OwnerRecord;
  readonly state: SessionState;
};

type Ticket = OwnerRecord & { readonly sessionId: string };

const holderFileName = 'holder.json';
const eventsDirectoryName = 'events';
const eventFile = /^\d{12}\.json$/;

function sessionsDirectory(directory: string): string {
  return join(directory, 'sessions');
}

function queueDirectory(directory: string): string {
  return join(directory, 'queue');
}

function ledgerDirectory(directory: string, sessionId: string): string {
  return join(sessionsDirectory(directory), sessionId.replaceAll(/[^\w-]/g, '_'));
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function readLedger(path: string): Promise<SessionLedger | undefined> {
  const holder = await readJson<OwnerRecord & { sessionId?: string }>(join(path, holderFileName));
  const names = await readdir(join(path, eventsDirectoryName)).catch(() => [] as string[]);
  const events: SessionEvent[] = [];
  let sessionId = holder?.sessionId;
  for (const name of names.filter((entry) => eventFile.test(entry)).toSorted()) {
    const event = await readJson<SessionEvent & { sessionId?: string }>(
      join(path, eventsDirectoryName, name),
    );
    if (event === undefined) continue;
    sessionId ??= event.sessionId;
    events.push(event);
  }
  if (holder === undefined && events.length === 0) return undefined;
  return {
    sessionId: sessionId ?? '',
    directory: path,
    ...(holder === undefined ? {} : { holder }),
    state: foldSession(events),
  };
}

/** Every session's ledger, without judging or changing any. */
export async function readSessions(directory: string): Promise<SessionLedger[]> {
  const root = sessionsDirectory(directory);
  const names = await readdir(root).catch(() => [] as string[]);
  const ledgers: SessionLedger[] = [];
  for (const name of names.toSorted()) {
    const ledger = await readLedger(join(root, name));
    if (ledger !== undefined) ledgers.push(ledger);
  }
  return ledgers;
}

/**
 * Appends one event to a session's ledger as the next numbered file. The file is written aside and
 * linked into place, which fails if another hook took that number first, so every event lands
 * whole and in one order.
 */
export async function appendEvent(
  directory: string,
  sessionId: string,
  event: SessionEvent,
): Promise<void> {
  const ledger = ledgerDirectory(directory, sessionId);
  const events = join(ledger, eventsDirectoryName);
  await mkdir(events, { recursive: true });
  const staged = join(ledger, `staged-${crypto.randomUUID()}.json`);
  await writeFile(staged, JSON.stringify({ ...event, sessionId }));
  try {
    for (;;) {
      const entries = await readdir(events);
      const names = entries.filter((name) => eventFile.test(name));
      const last = names.toSorted().at(-1);
      const next = (last === undefined ? 0 : Number(last.slice(0, 12))) + 1;
      try {
        await link(staged, join(events, `${String(next).padStart(12, '0')}.json`));
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  } finally {
    await rm(staged, { force: true });
  }
}

/** Records the session's process, in one rename, unless the ledger already names that process. */
async function recordHolder(directory: string, sessionId: string, holder: OwnerRecord) {
  const ledger = ledgerDirectory(directory, sessionId);
  const current = await readJson<OwnerRecord>(join(ledger, holderFileName));
  if (current?.pid === holder.pid && current.pidStartedAt === holder.pidStartedAt) return;
  await mkdir(ledger, { recursive: true });
  const staged = join(ledger, `${holderFileName}.${holder.token}`);
  await writeFile(staged, JSON.stringify({ ...holder, sessionId }));
  await rename(staged, join(ledger, holderFileName));
}

/** Whether a session's process lives; a table that cannot be read, or no recorded process, judges it alive. */
export function sessionAlive(ledger: SessionLedger, table: ProcessTable | undefined): boolean {
  return ledger.holder === undefined || table === undefined || isHolderAlive(ledger.holder, table);
}

/** The places every live session holds. */
export function hostPlaces(ledgers: readonly SessionLedger[]): number {
  return ledgers.reduce((sum, ledger) => sum + sessionPlaces(ledger.state), 0);
}

/**
 * The live ledgers, after reclaiming the rest: a ledger whose session process is gone is removed,
 * and an admitted dispatch with no start after the limit is expired. Run under the admission lock.
 */
export async function surveySessions(
  directory: string,
  table: ProcessTable | undefined,
  now: number,
  limit = neverStartedLimitMilliseconds,
): Promise<SessionLedger[]> {
  const live: SessionLedger[] = [];
  for (const ledger of await readSessions(directory)) {
    if (!sessionAlive(ledger, table)) {
      await rm(ledger.directory, { recursive: true, force: true });
      continue;
    }
    let state = ledger.state;
    for (const dispatch of neverStarted(state, now, limit)) {
      const event: SessionEvent = { kind: 'expire', toolUseId: dispatch.toolUseId, at: now };
      await appendEvent(directory, ledger.sessionId, event);
      state = applySessionEvent(state, event);
    }
    live.push({ ...ledger, state });
  }
  return live;
}

function age(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 120) return `${seconds}s`;
  const whole = Math.round(seconds / 60);
  return whole < 120 ? `${whole}m` : `${Math.floor(whole / 60)}h${whole % 60}m`;
}

/**
 * One session's places as lines: the session and its coordinator place, then one line per place
 * with the dispatch, its age, and whether an agent ever started for it.
 */
export function describeSession(
  ledger: SessionLedger,
  now: number,
  table: ProcessTable | undefined,
  limit = neverStartedLimitMilliseconds,
): string[] {
  const { state } = ledger;
  const workers = workerPlaces(state);
  const process =
    ledger.holder === undefined
      ? 'process not recorded'
      : `pid ${ledger.holder.pid} in ${ledger.holder.cwd}`;
  const gone = sessionAlive(ledger, table) ? '' : ' (its process has exited: reclaimable)';
  const lines = [
    `session ${ledger.sessionId.slice(0, 8)} (${process})${gone}: ${workers === 0 ? 'no place' : `${workers} worker place(s) and its coordinator's`}`,
  ];
  for (const dispatch of state.dispatches.values()) {
    const what = `worker ${dispatch.issue ?? 'without an issue'} "${dispatch.description}", dispatch ${dispatch.toolUseId}, admitted ${age(now - dispatch.admittedAt)} ago${dispatch.bypass ? ' past the cap' : ''}`;
    if (dispatch.status === 'pending' && dispatch.agentId !== undefined) {
      lines.push(`  place: ${what}, launched as agent ${dispatch.agentId}, no start recorded`);
    } else if (dispatch.status === 'pending') {
      const never = now - dispatch.admittedAt >= limit;
      lines.push(
        `  place: ${what}, ${never ? 'admitted, never started (reclaimed by the next dispatch)' : 'no agent started yet'}`,
      );
    }
  }
  for (const agent of state.agents.values()) {
    if (!agent.running) continue;
    const dispatch =
      agent.toolUseId === undefined ? undefined : state.dispatches.get(agent.toolUseId);
    const origin =
      dispatch === undefined
        ? 'without an admission'
        : `worker ${dispatch.issue ?? 'without an issue'} "${dispatch.description}", dispatch ${dispatch.toolUseId}, admitted ${age(now - dispatch.admittedAt)} ago`;
    const resumed = agent.runs > 1 ? `, resumed (run ${agent.runs}) without an admission` : '';
    const over = agent.overCap ? ', over the cap' : '';
    lines.push(
      `  place: ${runsWithoutAdmission(agent) && agent.runs === 1 ? 'agent started ' : ''}${origin}, agent ${agent.agentId} started ${age(now - agent.startedAt)} ago and running${resumed}${over}`,
    );
  }
  return lines;
}

/** The places as lines: a summary, then each session's. */
export function describePlaces(
  ledgers: readonly SessionLedger[],
  cap: number,
  now: number,
  table: ProcessTable | undefined,
): string[] {
  const held = hostPlaces(ledgers.filter((ledger) => sessionAlive(ledger, table)));
  return [
    `${held} of ${cap} host places held${held > cap ? ', over the cap' : ''}`,
    ...ledgers
      .filter((ledger) => sessionPlaces(ledger.state) > 0)
      .flatMap((ledger) => describeSession(ledger, now, table)),
  ];
}

/** Whether a ticket's waiter is alive in `table`; a table that cannot be read judges it alive. */
function ticketLive(waiter: OwnerRecord | undefined, table: ProcessTable | undefined): boolean {
  if (waiter === undefined) return false;
  if (table === undefined) return true;
  const entry = table.get(waiter.pid);
  return (
    entry !== undefined &&
    (waiter.pidStartedAt === undefined || entry.startedAt === waiter.pidStartedAt)
  );
}

/** The live tickets in arrival order, after removing the dead ones. */
async function liveTickets(
  queue: string,
  table: ProcessTable | undefined,
): Promise<Array<{ name: string; ticket: Ticket }>> {
  const names = await readdir(queue).catch(() => [] as string[]);
  const live: Array<{ name: string; ticket: Ticket }> = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).toSorted()) {
    const ticket = (await readTicket(queue, name)) as Ticket | undefined;
    if (ticket !== undefined && ticketLive(ticket, table)) live.push({ name, ticket });
    else await rm(join(queue, name), { force: true });
  }
  return live;
}

/** The waiters in arrival order, as lines. */
export async function describeWaiters(directory: string): Promise<string[]> {
  const queue = queueDirectory(directory);
  const names = await readdir(queue).catch(() => [] as string[]);
  const lines: string[] = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).toSorted()) {
    const waiter = await readTicket(queue, name);
    if (waiter !== undefined) lines.push(`  waiting: ${waiter.command}, pid ${waiter.pid}`);
  }
  return lines;
}

/**
 * The waiters admitted now, in arrival order: each whose need fits in what is left, the oldest
 * first, where a waiter needs one place, or two when its session has no worker yet.
 */
export function admissionPlan(
  waiters: ReadonlyArray<{ readonly name: string; readonly sessionId: string }>,
  ledgers: readonly SessionLedger[],
  cap: number,
): Set<string> {
  const workers = new Map<string, number>();
  for (const ledger of ledgers) {
    workers.set(
      ledger.sessionId,
      (workers.get(ledger.sessionId) ?? 0) + workerPlaces(ledger.state),
    );
  }
  let free = cap - hostPlaces(ledgers);
  const admitted = new Set<string>();
  for (const waiter of waiters) {
    const held = workers.get(waiter.sessionId) ?? 0;
    const need = held === 0 ? 2 : 1;
    if (need > free) continue;
    admitted.add(waiter.name);
    free -= need;
    workers.set(waiter.sessionId, held + 1);
  }
  return admitted;
}

export type PlaceRequest = {
  readonly sessionId: string;
  readonly dispatcher: string;
  readonly toolUseId: string;
  /** The dispatch's description. */
  readonly description: string;
  readonly issue?: string;
  readonly cwd: string;
  /** The session's process, which holds the places. */
  readonly holder: ProcessIdentity;
  /** The hook's process, which waits in the queue. */
  readonly waiter: ProcessIdentity;
};

export type AdmitOptions = {
  readonly directory: string;
  readonly request: PlaceRequest;
  readonly readProcessTable: () => ProcessTable | undefined;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** Told the holders once, when the dispatch starts waiting. */
  readonly report?: (lines: readonly string[]) => void;
  readonly cap?: number;
  readonly waitLimitMilliseconds?: number;
  readonly pollIntervalMilliseconds?: number;
  readonly neverStartedLimitMilliseconds?: number;
  /** Admit at once, past the cap. */
  readonly bypass?: boolean;
};

export type Admission =
  | {
      readonly admitted: true;
      readonly bypassed: boolean;
      readonly waitedMilliseconds: number;
      /** The places when the dispatch started waiting, when it waited. */
      readonly heldWhenWaiting?: readonly string[];
    }
  | { readonly admitted: false; readonly waitedMilliseconds: number; readonly held: string[] };

function ownerFor(
  processIdentity: ProcessIdentity,
  command: string,
  cwd: string,
  at: number,
): OwnerRecord {
  return {
    pid: processIdentity.pid,
    ...(processIdentity.pidStartedAt === undefined
      ? {}
      : { pidStartedAt: processIdentity.pidStartedAt }),
    command,
    cwd,
    acquiredAt: new Date(at).toISOString(),
    token: crypto.randomUUID(),
  };
}

/**
 * Runs `decide` holding the admission lock, a directory installed by one rename and naming the
 * hook's process, which the next hook removes once that process is gone. Never held across a wait.
 */
async function withAdmissionLock<T>(
  directory: string,
  owner: OwnerRecord,
  options: Pick<AdmitOptions, 'readProcessTable' | 'sleep'>,
  decide: () => Promise<T>,
): Promise<T> {
  const lock = join(directory, 'admission');
  for (;;) {
    const mine = { ...owner, token: crypto.randomUUID() };
    if (await tryInstall(lock, mine)) {
      try {
        return await decide();
      } finally {
        await removeLock(lock, mine);
      }
    }
    if (await reclaimAbandonedLock(lock, options)) continue;
    await options.sleep(admissionLockRetryMilliseconds);
  }
}

/** How long a reclaim guard may stand before it counts as left by a reclaimer that died. */
const reclaimGuardStaleMilliseconds = 30_000;

/**
 * Removes the admission lock when its owner is gone, judged while holding a reclaim guard, so the
 * lock judged is the lock removed: a reclaimer acting on a stale reading could otherwise move
 * aside a live lock another hook had just installed. Resolves to whether the lock was removed.
 */
async function reclaimAbandonedLock(
  lock: string,
  options: Pick<AdmitOptions, 'readProcessTable'>,
): Promise<boolean> {
  const guard = `${lock}.reclaiming`;
  try {
    await mkdir(guard);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stale = await stat(guard).then(
      ({ mtimeMs }) => Date.now() - mtimeMs >= reclaimGuardStaleMilliseconds,
      () => false,
    );
    if (stale) await rm(guard, { recursive: true, force: true });
    return false;
  }
  try {
    const holder = await readOwner(lock);
    if (holder === undefined) {
      // No owner file: the lock was released, and a hook may have installed another since the
      // failed install, which `removeLock` would move aside. Installs are whole, so a directory
      // without an owner was left by something else, and is removed only once it has stood a while.
      const ageMilliseconds = await stat(lock).then(
        ({ mtimeMs }) => Date.now() - mtimeMs,
        () => undefined,
      );
      if (ageMilliseconds === undefined) return true;
      if (ageMilliseconds < reclaimGuardStaleMilliseconds) return false;
      await removeLock(lock, undefined);
      return true;
    }
    const table = options.readProcessTable();
    if (table !== undefined && !isHolderAlive(holder, table)) {
      await removeLock(lock, holder);
      return true;
    }
    return false;
  } finally {
    await rm(guard, { recursive: true, force: true });
  }
}

function admitEvent(request: PlaceRequest, at: number, bypass: boolean): SessionEvent {
  return {
    kind: 'admit',
    toolUseId: request.toolUseId,
    at,
    description: request.description,
    ...(request.issue === undefined ? {} : { issue: request.issue }),
    dispatcher: request.dispatcher,
    ...(bypass ? { bypass } : {}),
  };
}

/**
 * Waits until the dispatch's places fit, oldest first among the waiters whose need fits, or until
 * the wait limit passes.
 */
export async function admitWorker(input: AdmitOptions): Promise<Admission> {
  // Snapshotted, so a caller that changes its options after an await cannot change this dispatch.
  const options = { ...input };
  const request: PlaceRequest = { ...input.request };
  const { directory, now } = options;
  const cap = options.cap ?? hostPlaceCap;
  const limit = options.waitLimitMilliseconds ?? placeWaitLimitMilliseconds;
  const started = now();
  const holder = ownerFor(request.holder, 'claude session', request.cwd, started);
  await mkdir(directory, { recursive: true });
  if (options.bypass === true) {
    // Past the cap, but counted like any other.
    await recordHolder(directory, request.sessionId, holder);
    await appendEvent(directory, request.sessionId, admitEvent(request, now(), true));
    return { admitted: true, bypassed: true, waitedMilliseconds: 0 };
  }
  const queue = queueDirectory(directory);
  const waiter = ownerFor(
    request.waiter,
    `worker ${request.issue ?? 'without an issue'} "${request.description}" (session ${request.sessionId.slice(0, 8)})`,
    request.cwd,
    started,
  );
  const ticket = await enqueue(queue, { ...waiter, sessionId: request.sessionId } as OwnerRecord);
  let heldWhenWaiting: string[] | undefined;
  try {
    for (;;) {
      const outcome = await withAdmissionLock(directory, waiter, options, async () => {
        const table = options.readProcessTable();
        // The tickets are read before the ledgers, so a waiter admitted in between is counted
        // twice, never missed.
        const waiters = await liveTickets(queue, table);
        const ledgers = await surveySessions(
          directory,
          table,
          now(),
          options.neverStartedLimitMilliseconds,
        );
        const plan = admissionPlan(
          waiters.map(({ name, ticket: entry }) => ({ name, sessionId: entry.sessionId })),
          ledgers,
          cap,
        );
        if (plan.has(ticket)) {
          await recordHolder(directory, request.sessionId, holder);
          await appendEvent(directory, request.sessionId, admitEvent(request, now(), false));
          return undefined;
        }
        return describePlaces(ledgers, cap, now(), table);
      });
      if (outcome === undefined) {
        return {
          admitted: true,
          bypassed: false,
          waitedMilliseconds: now() - started,
          ...(heldWhenWaiting === undefined ? {} : { heldWhenWaiting }),
        };
      }
      if (heldWhenWaiting === undefined) {
        heldWhenWaiting = outcome;
        options.report?.(outcome);
      }
      const waitedMilliseconds = now() - started;
      if (waitedMilliseconds >= limit)
        return { admitted: false, waitedMilliseconds, held: outcome };
      await options.sleep(options.pollIntervalMilliseconds ?? placePollIntervalMilliseconds);
    }
  } finally {
    await rm(join(queue, ticket), { force: true });
  }
}

const claudeCommand = /(?:^|\/)claude(?:\s|$)/;
const passThroughCommand = /(?:^|\/)-?(?:sh|bash|zsh|dash|fish|bun)(?:\s|$)/;
const desktopApplication = /\/Claude\.app\/Contents\/MacOS\/Claude(?:\s|$)/;

/**
 * The session's own process among the hook's ancestors: the nearest `claude` executable, or else
 * the nearest ancestor that is neither a shell, Bun, nor the desktop application, which outlives
 * every session.
 */
export function sessionProcess(hookPid: number, table: ProcessTable): number | undefined {
  const parents = new Map<number, number>();
  for (const [pid, entry] of table) if (entry.parent !== undefined) parents.set(pid, entry.parent);
  const ancestors = ancestorsOf(hookPid, parents);
  const command = (pid: number) => table.get(pid)?.command ?? '';
  return (
    ancestors.find((pid) => claudeCommand.test(command(pid))) ??
    ancestors.find(
      (pid) => !passThroughCommand.test(command(pid)) && !desktopApplication.test(command(pid)),
    )
  );
}

export type HookInput = {
  readonly hook_event_name?: unknown;
  readonly session_id?: unknown;
  readonly agent_id?: unknown;
  readonly agent_type?: unknown;
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
  readonly tool_use_id?: unknown;
  readonly tool_response?: unknown;
  readonly cwd?: unknown;
};

export type HookOutput = {
  readonly systemMessage?: string;
  readonly hookSpecificOutput?: {
    readonly hookEventName: 'PreToolUse';
    readonly permissionDecision?: 'deny';
    readonly permissionDecisionReason?: string;
    readonly additionalContext?: string;
  };
};

export type HookContext = {
  readonly directory: string;
  readonly hookPid: number;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly readProcessTable: () => ProcessTable | undefined;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** Where the holders go when a dispatch starts waiting: standard error in the hook. */
  readonly report?: (lines: readonly string[]) => void;
  readonly cap?: number;
  readonly waitLimitMilliseconds?: number;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

const issuePattern = /\b[A-Z][A-Z0-9]+-\d+\b/;

function minutes(milliseconds: number): string {
  return `${Math.round(milliseconds / 60_000)} minute(s)`;
}

function identity(pid: number, entry: ProcessEntry | undefined): ProcessIdentity {
  return entry === undefined ? { pid } : { pid, pidStartedAt: entry.startedAt };
}

async function admitDispatch(
  input: HookInput,
  context: HookContext,
): Promise<HookOutput | undefined> {
  const toolInput = input.tool_input;
  const description = text(field(toolInput, 'description'));
  const prompt = text(field(toolInput, 'prompt'));
  const table = context.readProcessTable();
  const session = table === undefined ? undefined : sessionProcess(context.hookPid, table);
  if (table === undefined || session === undefined) {
    const message = `host-sessions: could not find this session's process, so this dispatch took no host place (${capBypassVariable} was not needed).`;
    return { systemMessage: message };
  }
  const issue = issuePattern.exec(`${description} ${prompt}`)?.[0];
  const bypassText = context.environment[capBypassVariable] ?? '';
  const bypass =
    bypassText !== '' && (description.includes(bypassText) || prompt.includes(bypassText));
  const cap = context.cap ?? hostPlaceCap;
  const admission = await admitWorker({
    directory: context.directory,
    request: {
      sessionId: text(input.session_id),
      dispatcher: text(input.agent_id),
      toolUseId: text(input.tool_use_id),
      description: description.slice(0, 120),
      ...(issue === undefined ? {} : { issue }),
      cwd: text(input.cwd),
      holder: identity(session, table.get(session)),
      waiter: identity(context.hookPid, table.get(context.hookPid)),
    },
    readProcessTable: context.readProcessTable,
    now: context.now,
    sleep: context.sleep,
    ...(context.report === undefined
      ? {}
      : {
          report: (lines: readonly string[]) =>
            context.report?.([
              `host-sessions: this dispatch waits for one of the host's ${cap} places. Held now:`,
              ...lines,
            ]),
        }),
    cap,
    waitLimitMilliseconds: context.waitLimitMilliseconds ?? placeWaitLimitMilliseconds,
    bypass,
  });
  if (!admission.admitted) {
    const reason = [
      `Host place cap: this ${[...placeTakingAgentTypes].join('/')} dispatch waited ${minutes(admission.waitedMilliseconds)} for one of the host's ${cap} places for implementation workers and their coordinators (AGENTS.md "Parallel runs"), and none came free. The places:`,
      ...admission.held,
      `Retry the dispatch later, once a holder finishes; \`bun scripts/host-sessions.ts status\` lists the holders, and \`bun scripts/host-sessions.ts release <session, dispatch or agent>\` frees one that is stuck. On the owner's instruction only, a session started with ${capBypassVariable} set to text in a dispatch's description or prompt, such as its issue, admits that dispatch past the cap.`,
    ].join('\n');
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  }
  let message: string | undefined;
  if (admission.bypassed) {
    message = `host-sessions: ${capBypassVariable}=${bypassText} admitted this dispatch past the cap of ${cap} host places.`;
  } else if (admission.heldWhenWaiting !== undefined) {
    message = [
      `host-sessions: this dispatch waited ${minutes(admission.waitedMilliseconds)} for a host place. When it started waiting:`,
      ...admission.heldWhenWaiting,
    ].join('\n');
  }
  if (message === undefined) return undefined;
  return {
    systemMessage: message,
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message },
  };
}

/**
 * Records an agent's start. A start that takes no admitted dispatch's place (a resume by
 * `SendMessage`, or a dispatch reclaimed before it started) still counts, and is marked over the
 * cap when the host had no place for it.
 */
async function recordStart(input: HookInput, context: HookContext): Promise<void> {
  const sessionId = text(input.session_id);
  const agentId = text(input.agent_id);
  if (agentId === '') return;
  const table = context.readProcessTable();
  const session = table === undefined ? undefined : sessionProcess(context.hookPid, table);
  const ledgers = await readSessions(context.directory);
  let own = ledgers.find((ledger) => ledger.sessionId === sessionId);
  if (own !== undefined && !sessionAlive(own, table)) {
    // The session was resumed in a new process: what the old one ran ended with it.
    await rm(own.directory, { recursive: true, force: true });
    own = undefined;
  }
  if (own === undefined && session === undefined) return;
  if (session !== undefined && table !== undefined) {
    const holder = ownerFor(
      identity(session, table.get(session)),
      'claude session',
      text(input.cwd),
      context.now(),
    );
    await recordHolder(context.directory, sessionId, holder);
  }
  const event: SessionEvent = { kind: 'start', agentId, at: context.now() };
  const before = own?.state ?? foldSession([]);
  const after = applySessionEvent(before, event);
  const agent = after.agents.get(agentId);
  const others = ledgers.filter((ledger) => ledger !== own && sessionAlive(ledger, table));
  const overCap =
    agent !== undefined &&
    runsWithoutAdmission(agent) &&
    hostPlaces(others) + sessionPlaces(after) > (context.cap ?? hostPlaceCap);
  await appendEvent(context.directory, sessionId, overCap ? { ...event, overCap } : event);
}

/** Appends an event to a session that has a ledger; a session without one holds nothing to change. */
async function recordInLedger(directory: string, sessionId: string, event: SessionEvent) {
  const ledgers = await readSessions(directory);
  if (ledgers.some((ledger) => ledger.sessionId === sessionId)) {
    await appendEvent(directory, sessionId, event);
  }
}

/** The hook's answer to one event, after recording it; undefined to print nothing. */
export async function handleHookEvent(
  input: HookInput,
  context: HookContext,
): Promise<HookOutput | undefined> {
  const event = text(input.hook_event_name);
  const sessionId = text(input.session_id);
  const toolUseId = text(input.tool_use_id);
  const agentId = text(input.agent_id);
  const at = context.now();
  const isAgentCall =
    text(input.tool_name) === 'Agent' &&
    placeTakingAgentTypes.has(text(field(input.tool_input, 'subagent_type')));
  const isPlaceTakingAgent = placeTakingAgentTypes.has(text(input.agent_type));
  if (event === 'PreToolUse' && isAgentCall) return admitDispatch(input, context);
  if (event === 'SubagentStart' && isPlaceTakingAgent) {
    await recordStart(input, context);
  } else if ((event === 'SubagentStop' || event === 'StopFailure') && isPlaceTakingAgent) {
    if (agentId !== '') {
      await recordInLedger(context.directory, sessionId, { kind: 'stop', agentId, at });
    }
  } else if (event === 'PostToolUse' && isAgentCall && toolUseId !== '') {
    const status = text(field(input.tool_response, 'status'));
    const named = text(field(input.tool_response, 'agentId'));
    if (status === 'async_launched' && named !== '') {
      await recordInLedger(context.directory, sessionId, {
        kind: 'launched',
        toolUseId,
        agentId: named,
        at,
      });
    } else if (status === 'completed') {
      await recordInLedger(context.directory, sessionId, {
        kind: 'completed',
        toolUseId,
        agentId: named,
        at,
      });
    }
  } else if (
    (event === 'PostToolUseFailure' || event === 'PermissionDenied') &&
    isAgentCall &&
    toolUseId !== ''
  ) {
    await recordInLedger(context.directory, sessionId, { kind: 'failed', toolUseId, at });
  }
  return undefined;
}

/**
 * Frees a place by hand: every place of a session named by its id or the first eight characters
 * of it, or one dispatch's or agent's place. Resolves to what it freed, as lines.
 */
export async function releasePlace(
  directory: string,
  target: string,
  options: Pick<AdmitOptions, 'readProcessTable' | 'sleep' | 'now'> & { readonly pid: number },
): Promise<string[]> {
  const owner = ownerFor({ pid: options.pid }, `release ${target}`, process.cwd(), options.now());
  return withAdmissionLock(directory, owner, options, async () => {
    const ledgers = await readSessions(directory);
    const sessions = ledgers.filter(
      (ledger) =>
        ledger.sessionId === target || (target.length >= 8 && ledger.sessionId.startsWith(target)),
    );
    if (sessions.length > 1) {
      throw new Error(`${target} names ${sessions.length} sessions; give more of the session id`);
    }
    const [session] = sessions;
    if (session !== undefined) {
      const held = sessionPlaces(session.state);
      await rm(session.directory, { recursive: true, force: true });
      return [`released session ${session.sessionId}: ${held} place(s)`];
    }
    for (const ledger of ledgers) {
      const event: SessionEvent = { kind: 'release', target, at: options.now() };
      const after = applySessionEvent(ledger.state, event);
      if (after === ledger.state) continue;
      await appendEvent(directory, ledger.sessionId, event);
      const freed = sessionPlaces(ledger.state) - sessionPlaces(after);
      return [`released ${target} in session ${ledger.sessionId}: ${freed} place(s)`];
    }
    throw new Error(`no session, pending dispatch or running agent is named ${target}`);
  });
}

async function placesDirectory(argumentsList: readonly string[]): Promise<string> {
  const flag = argumentsList.find((argument) => argument.startsWith('--directory='));
  if (flag !== undefined) return flag.slice('--directory='.length);
  return join(await gitCommonDirectory(), placesDirectoryName);
}

async function runHook(argumentsList: readonly string[]): Promise<void> {
  let output: HookOutput | undefined;
  try {
    const input = JSON.parse(await Bun.stdin.text()) as HookInput;
    output = await handleHookEvent(input, {
      directory: await placesDirectory(argumentsList),
      hookPid: process.pid,
      environment: rootScriptEnvironment(),
      readProcessTable,
      now: () => Date.now(),
      sleep: (milliseconds) => Bun.sleep(milliseconds),
      report: (lines) => process.stderr.write(`${lines.join('\n')}\n`),
    });
  } catch (error) {
    // Loud, never silent: the dispatch goes ahead, and the session is told the cap was not checked.
    output = {
      systemMessage: `host-sessions: the host place cap was not checked: ${String(error)}`,
    };
  }
  if (output !== undefined) process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function printStatus(argumentsList: readonly string[]): Promise<void> {
  const directory = await placesDirectory(argumentsList);
  const lines = [
    `host places ${directory}:`,
    ...describePlaces(await readSessions(directory), hostPlaceCap, Date.now(), readProcessTable()),
    ...(await describeWaiters(directory)),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function release(argumentsList: readonly string[]): Promise<void> {
  const target = argumentsList.find((argument) => !argument.startsWith('--'));
  if (target === undefined) throw new Error('name a session, a dispatch or an agent to release');
  const lines = await releasePlace(await placesDirectory(argumentsList), target, {
    readProcessTable,
    sleep: (milliseconds) => Bun.sleep(milliseconds),
    now: () => Date.now(),
    pid: process.pid,
  });
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (import.meta.main) {
  const [command, ...rest] = Bun.argv.slice(2);
  if (command === 'hook') await runHook(rest);
  else if (command === 'status') await printStatus(rest);
  else if (command === 'release') {
    await release(rest).catch((error: unknown) => {
      process.stderr.write(
        `host-sessions: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
  } else {
    process.stderr.write(
      'Usage: bun scripts/host-sessions.ts status|release <session, dispatch or agent>|hook [--directory=<path>]\n',
    );
    process.exitCode = 64;
  }
}
