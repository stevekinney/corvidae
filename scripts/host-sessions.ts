#!/usr/bin/env bun
/**
 * The host-wide cap on agents and the sessions that run them (AGENTS.md "Parallel runs", COR-2455),
 * enforced by Claude Code hooks in `.claude/settings.json`.
 *
 * Every `Agent` dispatch takes a place, whatever its type, and the host runs one Opus agent at a
 * time ({@link opusAgentCap}), read from the dispatch's `model` or else its type's `model:`. A
 * `SessionStart` registers the session, so a session counts (its coordinator's place) from its
 * start or resume, and the refusal comes at the next dispatch. `PreToolUse` on `start_session`
 * denies a session that holds a lease marker (`leases/<session id>.json`, written by
 * `scripts/chef/linear.ts lease`).
 *
 * Each session that dispatches an agent keeps a ledger
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

import { readFileSync } from 'node:fs';
import { access, link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  isHolderAlive,
  readProcessTable,
  type ProcessEntry,
  type ProcessTable,
} from './bun-test-pool.ts';
import { defaultGit, stateDirectoryOf, type GitReader } from './chef/report.ts';
import { resolveMainCheckout } from './chef/repository-locations.ts';
import { questionDecision, workerStopDecision, type FenceOutput } from './chef/session-fences.ts';
import { rootScriptEnvironment } from './environment-configuration.ts';
import {
  applySessionEvent,
  foldSession,
  neverStarted,
  neverStartedLimitMilliseconds,
  opusPlaces,
  readOnlyAgents,
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
  isAbsentOrPartial,
  readTicket,
  reclaimAbandonedAs,
  removeLock,
  tryInstall,
  type LivenessJudge,
  type OwnerRecord,
} from './run-exclusively.ts';

/**
 * How many places the host has: implementation workers and their coordinators together. There is
 * no cap (owner decision, 2026-11-21): the ledger still records every dispatch for `status`, the
 * leases and the session fences, but no dispatch waits for a place or is refused one.
 */
const hostPlaceCap = Number.POSITIVE_INFINITY;

/** How long a dispatch waits for a place before it is denied. */
export const placeWaitLimitMilliseconds = 20 * 60 * 1000;

/** How often a waiting dispatch looks again. */
const placePollIntervalMilliseconds = 5_000;

/** How often a hook looks again for the admission lock, which is held only while deciding. */
export const admissionLockRetryMilliseconds = 100;

/** Set to text in one dispatch's description or prompt to admit that dispatch past the cap. */
export const capBypassVariable = 'CORVIDAE_AGENT_CAP_BYPASS';

/** How many Opus agents the host runs at once: no limit (owner decision, 2026-11-21). */
export const opusAgentCap = Number.POSITIVE_INFINITY;

/** How many read-only agents the host runs at once: no limit (owner decision, 2026-11-21). */
export const readOnlyAgentCap = Number.POSITIVE_INFINITY;

/**
 * The agent types that are read-only when no definition says otherwise: Claude Code's built-in
 * read-only agents. A type with a definition is read-only when its `tools:` list names neither
 * Edit nor Write; any other type is an implementation agent.
 */
const builtInReadOnlyAgentTypes: ReadonlySet<string> = new Set([
  'Explore',
  'Plan',
  'claude-code-guide',
  'statusline-setup',
]);

/**
 * The tool that starts a child session; a leased coordinator may not call it. Claude Code names an
 * MCP server's tool `mcp__<server>__<tool>`: the Claude desktop application's session server is
 * `ccd_session` and its tool `start_session`. The name is the one in a coordinator session's tool
 * list (confirmed 2026-11-19); a different host would name it differently and need its own matcher.
 */
export const startSessionToolName = 'mcp__ccd_session__start_session';

/** Whether an agent type takes no host place, from its definition's `tools:` or else the built-in list. */
export function isReadOnlyAgentType(agentType: string, tools: string | undefined): boolean {
  if (tools !== undefined) return !/\b(?:Edit|Write|NotebookEdit)\b/.test(tools);
  return builtInReadOnlyAgentTypes.has(agentType);
}

/** The places directory's name in the Git common directory. */
export const placesDirectoryName = 'corvidae-agent-places';

/** The Opus model is the one the Opus cap limits; a model named by anything else is not counted. */
const opusModel = /opus/i;

type ProcessIdentity = { readonly pid: number; readonly pidStartedAt?: string };

/** A session's ledger as read: its process, and its events folded. */
export type SessionLedger = {
  readonly sessionId: string;
  readonly directory: string;
  /** The session's process; absent when its ledger has none recorded yet. */
  readonly holder?: OwnerRecord;
  /**
   * Whether a `SessionStart` registered the session, so a resumed session is known at its next
   * dispatch. A registered session holds no place by itself. It is a file beside the holder, never
   * an event, so a checkout that does not know it folds the same ledger unchanged.
   */
  readonly registered: boolean;
  readonly state: SessionState;
};

type Ticket = OwnerRecord & {
  readonly sessionId: string;
  readonly opus?: boolean;
  readonly readOnly?: boolean;
};

const holderFileName = 'holder.json';
const registeredFileName = 'registered.json';
const eventsDirectoryName = 'events';
const eventFile = /^\d{12}\.json$/;

function sessionsDirectory(directory: string): string {
  return join(directory, 'sessions');
}

function queueDirectory(directory: string): string {
  return join(directory, 'queue');
}

function safeSessionName(sessionId: string): string {
  return sessionId.replaceAll(/[^\w-]/g, '_');
}

function ledgerDirectory(directory: string, sessionId: string): string {
  return join(sessionsDirectory(directory), safeSessionName(sessionId));
}

/** A coordinator's lease marker: `leases/<session id>.json` in the places directory. */
export function leaseMarkerPath(directory: string, sessionId: string): string {
  return join(directory, 'leases', `${safeSessionName(sessionId)}.json`);
}

export type LeaseMarker = {
  readonly sessionId: string;
  readonly project: string;
  readonly run: string;
  readonly leasedAt: string;
  /** When the lease lapses unless renewed; the hooks treat a marker past it as absent. */
  readonly expiresAt?: string;
};

/** Whether a marker still binds its session at `now`; one without an expiry always does. */
export function leaseMarkerLive(marker: LeaseMarker, now: number): boolean {
  if (marker.expiresAt === undefined) return true;
  const expiry = Date.parse(marker.expiresAt);
  return Number.isNaN(expiry) || expiry > now;
}

/** The lease marker a session holds, if any. */
export async function readLeaseMarker(
  directory: string,
  sessionId: string,
): Promise<LeaseMarker | undefined> {
  return readJson<LeaseMarker>(leaseMarkerPath(directory, sessionId));
}

/** Writes the marker whole, in one rename, so a hook never reads half of it. */
export async function writeLeaseMarker(directory: string, marker: LeaseMarker): Promise<void> {
  const path = leaseMarkerPath(directory, marker.sessionId);
  await mkdir(join(directory, 'leases'), { recursive: true });
  const staged = `${path}.${crypto.randomUUID()}`;
  await writeFile(staged, JSON.stringify(marker));
  await rename(staged, path);
}

export async function removeLeaseMarker(directory: string, sessionId: string): Promise<void> {
  await rm(leaseMarkerPath(directory, sessionId), { force: true });
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    // Missing or half written: every caller treats an absent record as not there yet. Any other
    // failure to read it is thrown, never read as no record.
    if (isAbsentOrPartial(error)) return undefined;
    throw error;
  }
}

/**
 * One ledger as it stands. The events are read before the holder: every ledger records its holder
 * before its first event and replaces it only by a rename, so a ledger read with events and no
 * holder has none, and is not one caught between its holder and its first event.
 */
async function readLedger(path: string): Promise<SessionLedger | undefined> {
  const names = await readdir(join(path, eventsDirectoryName)).catch(() => [] as string[]);
  const events: SessionEvent[] = [];
  let eventSessionId: string | undefined;
  for (const name of names.filter((entry) => eventFile.test(entry)).toSorted()) {
    const event = await readJson<SessionEvent & { sessionId?: string }>(
      join(path, eventsDirectoryName, name),
    );
    if (event === undefined) continue;
    eventSessionId ??= event.sessionId;
    events.push(event);
  }
  const holder = await readJson<OwnerRecord & { sessionId?: string }>(join(path, holderFileName));
  const sessionId = holder?.sessionId ?? eventSessionId;
  if (holder === undefined && events.length === 0) return undefined;
  const registered = await access(join(path, registeredFileName)).then(
    () => true,
    () => false,
  );
  return {
    sessionId: sessionId ?? '',
    directory: path,
    ...(holder === undefined ? {} : { holder }),
    registered,
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

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Appends one event to a session's ledger as the next numbered file, and resolves to whether it
 * did. The file is written aside and linked into place, which fails if another hook took that
 * number first, so every event lands whole and in one order. An append never creates a ledger: a
 * ledger is created by recording its holder, and one removed meanwhile (its process gone, or
 * released by hand) holds nothing, so the event is dropped rather than recreating it without its
 * holder (COR-2463).
 */
export async function appendEvent(
  directory: string,
  sessionId: string,
  event: SessionEvent,
): Promise<boolean> {
  const ledger = ledgerDirectory(directory, sessionId);
  const events = join(ledger, eventsDirectoryName);
  const staged = join(ledger, `staged-${crypto.randomUUID()}.json`);
  try {
    await mkdir(events).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    await writeFile(staged, JSON.stringify({ ...event, sessionId }));
    for (;;) {
      const listed = await readdir(events);
      const names = listed.filter((name) => eventFile.test(name));
      const last = names.toSorted().at(-1);
      const next = (last === undefined ? 0 : Number(last.slice(0, 12))) + 1;
      try {
        await link(staged, join(events, `${String(next).padStart(12, '0')}.json`));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  } finally {
    await rm(staged, { force: true });
  }
}

/**
 * Records the session's process, in one rename, unless the ledger already names that process.
 * This is what creates a ledger; a ledger removed while the holder was being written is created
 * again, since the holder is current.
 */
async function recordHolder(directory: string, sessionId: string, holder: OwnerRecord) {
  const ledger = ledgerDirectory(directory, sessionId);
  const current = await readJson<OwnerRecord>(join(ledger, holderFileName));
  if (current?.pid === holder.pid && current.pidStartedAt === holder.pidStartedAt) return;
  const staged = join(ledger, `${holderFileName}.${holder.token}`);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(ledger, { recursive: true });
      await writeFile(staged, JSON.stringify({ ...holder, sessionId }));
      await rename(staged, join(ledger, holderFileName));
      return;
    } catch (error) {
      if (!isMissing(error) || attempt >= 2) throw error;
    }
  }
}

/** Where removed ledgers go before they are deleted; anything left in it is garbage. */
function removedDirectory(directory: string): string {
  return join(directory, 'removed');
}

/**
 * Removes a ledger in one rename, out of the sessions directory, then deletes it, so an append
 * racing the removal finds the ledger whole or gone, never half-deleted.
 */
async function removeLedger(directory: string, ledger: string): Promise<void> {
  const removed = removedDirectory(directory);
  await mkdir(removed, { recursive: true });
  const aside = join(removed, crypto.randomUUID());
  try {
    await rename(ledger, aside);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  await rm(aside, { recursive: true, force: true });
}

/** Whether a session's process lives; a table that cannot be read, or no recorded process, judges it alive. */
export function sessionAlive(ledger: SessionLedger, table: ProcessTable | undefined): boolean {
  return ledger.holder === undefined || table === undefined || isHolderAlive(ledger.holder, table);
}

/** The places one session holds: its implementation workers', and its coordinator's while it has any. */
export function ledgerPlaces(ledger: SessionLedger): number {
  return sessionPlaces(ledger.state);
}

/** The read-only agents every live session holds. */
export function hostReadOnlyAgents(ledgers: readonly SessionLedger[]): number {
  return ledgers.reduce((sum, ledger) => sum + readOnlyAgents(ledger.state), 0);
}

/** The places every live session holds. */
export function hostPlaces(ledgers: readonly SessionLedger[]): number {
  return ledgers.reduce((sum, ledger) => sum + ledgerPlaces(ledger), 0);
}

/** The Opus agents every live session holds. */
export function hostOpusAgents(ledgers: readonly SessionLedger[]): number {
  return ledgers.reduce((sum, ledger) => sum + opusPlaces(ledger.state), 0);
}

/**
 * The live ledgers, after reclaiming the rest: a ledger whose session process is gone is removed,
 * and so is one without its holder, which no live session can be (an older checkout's append
 * recreated it after its removal); an admitted dispatch with no start after the limit is expired.
 * Run under the admission lock.
 */
export async function surveySessions(
  directory: string,
  table: ProcessTable | undefined,
  now: number,
  limit = neverStartedLimitMilliseconds,
): Promise<SessionLedger[]> {
  // Ledgers a killed hook moved aside and never deleted. The directory stays, for a removal that
  // is about to move a ledger into it.
  const removed = removedDirectory(directory);
  const leftovers = await readdir(removed).catch((error: unknown) => {
    if (isMissing(error)) return [] as string[];
    throw error;
  });
  for (const name of leftovers) {
    await rm(join(removed, name), { recursive: true, force: true });
  }
  const live: SessionLedger[] = [];
  for (const ledger of await readSessions(directory)) {
    if (ledger.holder === undefined || !sessionAlive(ledger, table)) {
      await removeLedger(directory, ledger.directory);
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
function describePlaces(
  ledgers: readonly SessionLedger[],
  cap: number,
  now: number,
  table: ProcessTable | undefined,
): string[] {
  const live = ledgers.filter((ledger) => sessionAlive(ledger, table));
  const held = hostPlaces(live);
  const opus = hostOpusAgents(live);
  const readOnly = hostReadOnlyAgents(live);
  return [
    `${held} of ${cap} host places held${held > cap ? ', over the cap' : ''}`,
    ...(readOnly === 0
      ? []
      : [`${readOnly} of ${readOnlyAgentCap} read-only agent(s) held, which take no host place`]),
    ...(opus === 0
      ? []
      : [`${opus} of ${opusAgentCap} Opus agent(s) held: the host runs ${opusAgentCap} at a time`]),
    ...ledgers
      .filter((ledger) => ledgerPlaces(ledger) > 0)
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
 * first, where an implementation waiter needs one place, or two when its session has no worker
 * yet, and a read-only waiter needs none. A waiter holds nothing while it waits: its session's
 * coordinator place is counted only once a dispatch is admitted.
 */
export function admissionPlan(
  waiters: ReadonlyArray<{
    readonly name: string;
    readonly sessionId: string;
    readonly opus?: boolean;
    readonly readOnly?: boolean;
  }>,
  ledgers: readonly SessionLedger[],
  cap: number,
  opusCap = opusAgentCap,
  readOnlyCap = readOnlyAgentCap,
): Set<string> {
  const workers = new Map<string, number>();
  for (const ledger of ledgers) {
    workers.set(
      ledger.sessionId,
      (workers.get(ledger.sessionId) ?? 0) + workerPlaces(ledger.state),
    );
  }
  let free = cap - hostPlaces(ledgers);
  let opusHeld = hostOpusAgents(ledgers);
  let readOnlyHeld = hostReadOnlyAgents(ledgers);
  const admitted = new Set<string>();
  for (const waiter of waiters) {
    const held = workers.get(waiter.sessionId) ?? 0;
    const readOnly = waiter.readOnly === true;
    const need = readOnly ? 0 : held === 0 ? 2 : 1;
    if (need > free) continue;
    if (readOnly && readOnlyHeld >= readOnlyCap) continue;
    // An Opus waiter waits while an Opus agent is held, one admitted earlier in this plan
    // included, and never holds back a later waiter that is not Opus.
    if (waiter.opus === true && opusHeld >= opusCap) continue;
    admitted.add(waiter.name);
    free -= need;
    if (waiter.opus === true) opusHeld += 1;
    if (readOnly) readOnlyHeld += 1;
    else workers.set(waiter.sessionId, held + 1);
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
  /** The dispatch's `subagent_type`, which an agent of that type takes the place of first. */
  readonly agentType?: string;
  /** Whether the dispatch runs on Opus, so that the host's Opus cap applies to it. */
  readonly opus?: boolean;
  /** Whether the agent type is read-only: no host place, but the read-only cap. */
  readonly readOnly?: boolean;
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
  readonly opusCap?: number;
  readonly readOnlyCap?: number;
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
  | {
      readonly admitted: false;
      readonly waitedMilliseconds: number;
      readonly held: string[];
      readonly ledgerLost?: true;
    };

function ownerFor(
  holderProcess: ProcessIdentity,
  command: string,
  cwd: string,
  at: number,
): OwnerRecord {
  return {
    pid: holderProcess.pid,
    ...(holderProcess.pidStartedAt === undefined
      ? {}
      : { pidStartedAt: holderProcess.pidStartedAt }),
    command,
    cwd,
    acquiredAt: new Date(at).toISOString(),
    token: crypto.randomUUID(),
  };
}

/**
 * How long an admission lock directory without an owner file may stand before it is removed.
 * Installs are whole, so such a directory was left by something else.
 */
const ownerlessAdmissionLockMilliseconds = 30_000;

/**
 * Judges recorded processes from a process table read when the judge is asked for, so a hook that
 * wrote its token before the listing is in it. A table that cannot be read judges every one alive.
 */
function tableJudge(readTable: () => ProcessTable | undefined): LivenessJudge {
  return () => {
    const table = readTable();
    return (record) => table === undefined || isHolderAlive(record, table);
  };
}

/**
 * Runs `decide` holding the admission lock, a directory installed by one rename and naming the
 * hook's process, which the next hook removes once that process is gone, through the reclaim guard
 * every lock shares (`reclaimAbandonedAs` in `scripts/run-exclusively.ts`). Never held across a wait.
 */
async function withAdmissionLock<T>(
  directory: string,
  owner: OwnerRecord,
  options: Pick<AdmitOptions, 'readProcessTable' | 'sleep'>,
  decide: () => Promise<T>,
): Promise<T> {
  const lock = join(directory, 'admission');
  const judge = tableJudge(options.readProcessTable);
  for (;;) {
    const mine = { ...owner, token: crypto.randomUUID() };
    if (await tryInstall(lock, mine)) {
      try {
        return await decide();
      } finally {
        await removeLock(lock, mine);
      }
    }
    const claimant = { ...owner, token: crypto.randomUUID() };
    if (await reclaimAbandonedAs(lock, ownerlessAdmissionLockMilliseconds, { judge, claimant })) {
      continue;
    }
    await options.sleep(admissionLockRetryMilliseconds);
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
    ...(request.agentType === undefined || request.agentType === ''
      ? {}
      : { agentType: request.agentType }),
    ...(request.opus === true ? { opus: true } : {}),
    ...(request.readOnly === true ? { readOnly: true } : {}),
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
  const ledgerLost = (): Admission => ({
    admitted: false,
    waitedMilliseconds: now() - started,
    held: [],
    ledgerLost: true,
  });
  await mkdir(directory, { recursive: true });
  if (options.bypass === true) {
    // Past the cap, but counted like any other, and recorded under the admission lock like every
    // write of a holder, so a survey cannot remove the ledger it has just made live.
    const hook = ownerFor(request.waiter, `bypass ${request.toolUseId}`, request.cwd, started);
    const recorded = await withAdmissionLock(directory, hook, options, async () => {
      await recordHolder(directory, request.sessionId, holder);
      return appendEvent(directory, request.sessionId, admitEvent(request, now(), true));
    });
    if (!recorded) return ledgerLost();
    return { admitted: true, bypassed: true, waitedMilliseconds: 0 };
  }
  const queue = queueDirectory(directory);
  const waiter = ownerFor(
    request.waiter,
    `worker ${request.issue ?? 'without an issue'} "${request.description}" (session ${request.sessionId.slice(0, 8)})`,
    request.cwd,
    started,
  );
  const ticket = await enqueue(queue, {
    ...waiter,
    sessionId: request.sessionId,
    ...(request.opus === true ? { opus: true } : {}),
    ...(request.readOnly === true ? { readOnly: true } : {}),
  } as OwnerRecord);
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
          waiters.map(({ name, ticket: entry }) => ({
            name,
            sessionId: entry.sessionId,
            ...(entry.opus === true ? { opus: true } : {}),
            ...(entry.readOnly === true ? { readOnly: true } : {}),
          })),
          ledgers,
          cap,
          options.opusCap,
          options.readOnlyCap,
        );
        if (plan.has(ticket)) {
          await recordHolder(directory, request.sessionId, holder);
          const recorded = await appendEvent(
            directory,
            request.sessionId,
            admitEvent(request, now(), false),
          );
          return recorded ? undefined : 'ledger-lost';
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
      if (outcome === 'ledger-lost') return ledgerLost();
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
  /** `SessionStart`: startup, resume, clear or compact. */
  readonly source?: unknown;
  /** The session's transcript, which the context fence measures. */
  readonly transcript_path?: unknown;
  /** `SubagentStop`: the stopping agent's own transcript. */
  readonly agent_transcript_path?: unknown;
};

export type HookOutput = {
  readonly systemMessage?: string;
  /** `SubagentStop`: `block` keeps the worker running and gives it `reason`. */
  readonly decision?: 'block';
  readonly reason?: string;
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
  readonly opusCap?: number;
  readonly waitLimitMilliseconds?: number;
  /** The `model:` an agent type's definition names, when a dispatch names no model. */
  readonly readAgentModel?: (agentType: string) => string | undefined;
  /** The `tools:` an agent type's definition lists, which decide whether it is read-only. */
  readonly readAgentTools?: (agentType: string) => string | undefined;
  readonly readOnlyCap?: number;
  /** The coordinator's execution state and briefs, in the main checkout; absent when not found. */
  readonly chef?:
    | {
        readonly stateDirectory: string;
        readonly briefsDirectory: string;
        /** Reads git in a worktree, to compare a report's head with the worker's. */
        readonly git?: GitReader;
      }
    | undefined;
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

function denyDispatch(reason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
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
  const agentType = text(field(toolInput, 'subagent_type'));
  const model = text(field(toolInput, 'model')) || (context.readAgentModel?.(agentType) ?? '');
  // With neither a model on the dispatch nor one in the type's definition, the agent inherits
  // its dispatcher's, which is not known here: it is not counted as Opus.
  const opus = opusModel.test(model);
  const readOnly = isReadOnlyAgentType(agentType, context.readAgentTools?.(agentType));
  const admission = await admitWorker({
    directory: context.directory,
    request: {
      sessionId: text(input.session_id),
      dispatcher: text(input.agent_id),
      toolUseId: text(input.tool_use_id),
      description: description.slice(0, 120),
      ...(issue === undefined ? {} : { issue }),
      ...(agentType === '' ? {} : { agentType }),
      ...(opus ? { opus } : {}),
      ...(readOnly ? { readOnly } : {}),
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
    ...(context.opusCap === undefined ? {} : { opusCap: context.opusCap }),
    ...(context.readOnlyCap === undefined ? {} : { readOnlyCap: context.readOnlyCap }),
    waitLimitMilliseconds: context.waitLimitMilliseconds ?? placeWaitLimitMilliseconds,
    bypass,
  });
  if (!admission.admitted) {
    if (admission.ledgerLost === true) {
      return denyDispatch(
        'The host could not record this dispatch because its session ledger disappeared. Retry the dispatch.',
      );
    }
    const reason = [
      `Host place cap: this ${opus ? 'Opus ' : ''}${agentType === '' ? 'agent' : agentType} dispatch waited ${minutes(admission.waitedMilliseconds)} for ${readOnly ? `one of the host's ${readOnlyAgentCap} read-only agent slots` : `one of the host's ${cap} places for implementation agents and their coordinators`}${opus ? `, or for the host's only Opus agent (${opusAgentCap} at a time)` : ''} (AGENTS.md "Parallel runs"), and none came free. The places:`,
      ...admission.held,
      `Retry the dispatch later, once a holder finishes; \`bun scripts/host-sessions.ts status\` lists the holders, and \`bun scripts/host-sessions.ts release <session, dispatch or agent>\` frees one that is stuck. On the owner's instruction only, a session started with ${capBypassVariable} set to text in a dispatch's description or prompt, such as its issue, admits that dispatch past the cap.`,
    ].join('\n');
    return denyDispatch(reason);
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
  const hook = ownerFor(
    identity(context.hookPid, table?.get(context.hookPid)),
    `agent ${agentId} start (session ${sessionId.slice(0, 8)})`,
    text(input.cwd),
    context.now(),
  );
  await mkdir(context.directory, { recursive: true });
  // Under the admission lock, like every write of a holder: an admission's survey removes a ledger
  // it read without a holder or with a dead one, and must not remove it after this start has
  // recorded the session's live process in it (COR-2463).
  await withAdmissionLock(context.directory, hook, context, async () => {
    const ledgers = await readSessions(context.directory);
    let own = ledgers.find((ledger) => ledger.sessionId === sessionId);
    if (own !== undefined && !sessionAlive(own, table)) {
      // The session was resumed in a new process: what the old one ran ended with it.
      await removeLedger(context.directory, own.directory);
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
    const agentType = text(input.agent_type);
    const event: SessionEvent = {
      kind: 'start',
      agentId,
      at: context.now(),
      ...(agentType === '' ? {} : { agentType }),
      ...(isReadOnlyAgentType(agentType, context.readAgentTools?.(agentType))
        ? { readOnly: true }
        : {}),
    };
    const before = own?.state ?? foldSession([]);
    const after = applySessionEvent(before, event);
    const agent = after.agents.get(agentId);
    const others = ledgers.filter((ledger) => ledger !== own && sessionAlive(ledger, table));
    const overCap =
      agent !== undefined &&
      runsWithoutAdmission(agent) &&
      hostPlaces(others) + sessionPlaces(after) > (context.cap ?? hostPlaceCap);
    await appendEvent(context.directory, sessionId, overCap ? { ...event, overCap } : event);
  });
}

/** Appends an event to a session that has a ledger; a session without one holds nothing to change. */
async function recordInLedger(directory: string, sessionId: string, event: SessionEvent) {
  const ledgers = await readSessions(directory);
  if (ledgers.some((ledger) => ledger.sessionId === sessionId)) {
    await appendEvent(directory, sessionId, event);
  }
}

/**
 * Registers a session at its start, or at its resume in a new process, so it is known and counted
 * at its next dispatch. A registered session holds no place by itself: its coordinator place is
 * held only while it has an implementation agent, so idle sessions never starve a dispatch.
 * `SessionStart` cannot block; the refusal is at a dispatch. A ledger whose process is gone is removed first, as in
 * `recordStart`, so a resumed session does not revive what the old process ran.
 */
async function registerSession(
  input: HookInput,
  context: HookContext,
): Promise<HookOutput | undefined> {
  const sessionId = text(input.session_id);
  if (sessionId === '') return undefined;
  const table = context.readProcessTable();
  const session = table === undefined ? undefined : sessionProcess(context.hookPid, table);
  if (table === undefined || session === undefined) {
    return {
      systemMessage:
        "host-sessions: could not find this session's process, so it was not registered against the host place cap.",
    };
  }
  const cwd = text(input.cwd);
  const hook = ownerFor(
    identity(context.hookPid, table.get(context.hookPid)),
    `session ${sessionId.slice(0, 8)} start`,
    cwd,
    context.now(),
  );
  await mkdir(context.directory, { recursive: true });
  await withAdmissionLock(context.directory, hook, context, async () => {
    const ledgers = await readSessions(context.directory);
    const own = ledgers.find((ledger) => ledger.sessionId === sessionId);
    if (own !== undefined && !sessionAlive(own, table)) {
      await removeLedger(context.directory, own.directory);
    }
    const holder = ownerFor(
      identity(session, table.get(session)),
      'claude session',
      cwd,
      context.now(),
    );
    await recordHolder(context.directory, sessionId, holder);
    await writeFile(
      join(ledgerDirectory(context.directory, sessionId), registeredFileName),
      JSON.stringify({ registeredAt: new Date(context.now()).toISOString() }),
    );
  });
  return undefined;
}

/** Denies `start_session` from a session that holds a coordinator lease marker. */
async function denyLeasedStartSession(
  sessionId: string,
  context: HookContext,
): Promise<HookOutput | undefined> {
  if (sessionId === '') return undefined;
  const marker = await readLeaseMarker(context.directory, sessionId);
  if (marker === undefined || !leaseMarkerLive(marker, context.now())) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `This session holds the coordinator lease for ${marker.project} (run ${marker.run}, since ${marker.leasedAt}), and a leased coordinator starts no child session: it dispatches Agent subagents (chef-worker, stickler) from this one, so that one coordinator takes the owner's instructions. End the lease with \`bun scripts/chef/linear.ts lease ${marker.project} --run ${marker.run} --release\` first if this session should hand work to another.`,
    },
  };
}

/** The lease a session holds, if its marker is live; a session that holds none is unleased. */
async function leasedSession(
  sessionId: string,
  context: HookContext,
): Promise<{ project: string; run: string } | undefined> {
  if (sessionId === '') return undefined;
  const marker = await readLeaseMarker(context.directory, sessionId);
  return marker !== undefined && leaseMarkerLive(marker, context.now())
    ? { project: marker.project, run: marker.run }
    : undefined;
}

/**
 * The charter mechanisms of `scripts/chef/session-fences.ts`, decided before anything is admitted or
 * recorded: a worker's stop without a valid report, and a question from a leased session. Only a refusal is returned; a decision that could not read its input is logged and the event goes on.
 */
async function sessionFences(
  input: HookInput,
  context: HookContext,
): Promise<HookOutput | undefined> {
  const event = text(input.hook_event_name);
  const tool = text(input.tool_name);
  const sessionId = text(input.session_id);
  let decision: FenceOutput | undefined;
  try {
    if (event === 'SubagentStop') {
      decision = workerStopDecision({
        agentType: text(input.agent_type),
        agentId: text(input.agent_id),
        transcriptPath: text(input.agent_transcript_path),
        stateDirectory: context.chef?.stateDirectory,
        briefsDirectory: context.chef?.briefsDirectory,
        git: context.chef?.git,
      });
    } else if (event === 'PreToolUse' && tool === 'AskUserQuestion') {
      decision = questionDecision(await leasedSession(sessionId, context));
    }
  } catch (error) {
    context.report?.([`session-fences: not enforced, ${String(error)}`]);
    return undefined;
  }
  if (decision?.systemMessage !== undefined) context.report?.([decision.systemMessage]);
  if (decision?.decision === undefined && decision?.hookSpecificOutput === undefined)
    return undefined;
  return decision;
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
  const fenced = await sessionFences(input, context);
  if (fenced !== undefined) return fenced;
  // Every Agent dispatch takes a place, whatever its type: reviewers, Explore and general-purpose
  // agents run models too.
  const isAgentCall = text(input.tool_name) === 'Agent';
  if (event === 'PreToolUse' && text(input.tool_name) === startSessionToolName) {
    return denyLeasedStartSession(sessionId, context);
  }
  if (event === 'PreToolUse' && isAgentCall) return admitDispatch(input, context);
  if (event === 'SessionStart') return registerSession(input, context);
  if (event === 'SubagentStart') {
    await recordStart(input, context);
  } else if (event === 'SubagentStop' || event === 'StopFailure') {
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
  // With its start time, so a `release` killed holding the lock does not hold it under a reused pid.
  const own = identity(options.pid, options.readProcessTable()?.get(options.pid));
  const owner = ownerFor(own, `release ${target}`, process.cwd(), options.now());
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
      const held = ledgerPlaces(session);
      await removeLedger(directory, session.directory);
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

/** The places directory every worktree shares, in the Git common directory. */
export async function hostPlacesDirectory(): Promise<string> {
  return join(await gitCommonDirectory(), placesDirectoryName);
}

async function placesDirectory(argumentsList: readonly string[]): Promise<string> {
  const flag = argumentsList.find((argument) => argument.startsWith('--directory='));
  if (flag !== undefined) return flag.slice('--directory='.length);
  return hostPlacesDirectory();
}

/**
 * One key of a Markdown file's front matter, if it has it: the text after the colon, or else the
 * `- item` lines under it joined by commas.
 */
export function frontmatterField(markdown: string, key: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  const lines = match?.[1]?.split(/\r?\n/) ?? [];
  const index = lines.findIndex((each) => new RegExp(`^${key}\\s*:`).test(each));
  const line = lines[index];
  if (line === undefined) return undefined;
  const value = line
    .slice(line.indexOf(':') + 1)
    .trim()
    .replaceAll(/^["']|["']$/g, '');
  if (value !== '') return value;
  const items: string[] = [];
  for (const next of lines.slice(index + 1)) {
    const item = /^\s*-\s*(.+)$/.exec(next)?.[1];
    if (item === undefined) break;
    items.push(item.trim());
  }
  return items.length === 0 ? undefined : items.join(', ');
}

/**
 * Reads one front-matter key of an agent type's definition, `.claude/agents/<type>.md` in the
 * project, else the user's. The first definition found answers, whether or not it has the key. A
 * type that is not a plain file name is never turned into a path.
 */
function agentDefinitionReader(
  projectDirectory: string,
  key: string,
): (agentType: string) => string | undefined {
  return (agentType) => {
    if (!/^[\w.-]+$/.test(agentType) || agentType.startsWith('.')) return undefined;
    for (const root of [projectDirectory, homedir()]) {
      try {
        return frontmatterField(
          readFileSync(join(root, '.claude', 'agents', `${agentType}.md`), 'utf8'),
          key,
        );
      } catch (error) {
        // No definition there: the next directory, and then none on record.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return undefined;
  };
}

/** The coordinator's execution state and briefs; `undefined` when no main checkout is found. */
function chefDirectories(cwd: string): HookContext['chef'] {
  try {
    const main = resolveMainCheckout(undefined, cwd);
    return {
      stateDirectory: stateDirectoryOf(main),
      briefsDirectory: join(main, 'tmp', 'chef', 'briefs'),
      git: defaultGit,
    };
  } catch {
    // Every failure is safe: with no main checkout there is no state to read, and the hooks that
    // need it fail open with a logged reason.
    return undefined;
  }
}

async function runHook(argumentsList: readonly string[]): Promise<void> {
  let output: HookOutput | undefined;
  try {
    const input = JSON.parse(await Bun.stdin.text()) as HookInput;
    const environment = rootScriptEnvironment();
    const projectDirectory =
      environment['CLAUDE_PROJECT_DIR'] ?? (typeof input.cwd === 'string' ? input.cwd : '.');
    output = await handleHookEvent(input, {
      directory: await placesDirectory(argumentsList),
      hookPid: process.pid,
      environment,
      readAgentModel: agentDefinitionReader(projectDirectory, 'model'),
      readAgentTools: agentDefinitionReader(projectDirectory, 'tools'),
      readProcessTable,
      now: () => Date.now(),
      sleep: (milliseconds) => Bun.sleep(milliseconds),
      report: (lines) => process.stderr.write(`${lines.join('\n')}\n`),
      chef: chefDirectories(typeof input.cwd === 'string' ? input.cwd : process.cwd()),
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
