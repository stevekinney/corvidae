#!/usr/bin/env bun
/**
 * The host-wide cap on implementation workers and the coordinators that dispatch them (AGENTS.md
 * "Parallel runs", COR-2455), enforced by Claude Code hooks in `.claude/settings.json`.
 *
 * A place is a record in the Git common directory, which every worktree shares, built as the test
 * slot pool's slots are (`scripts/bun-test-pool.ts`): a directory installed by one atomic rename,
 * whose owner file names the holder's process by pid and start time, and which the next waiter
 * reclaims once that process is gone. The holder is the Claude Code session's own process, the
 * nearest `claude` ancestor of the hook, never the short-lived hook; a session killed outright
 * leaves its places to be reclaimed.
 *
 * - `PreToolUse` on an `Agent` call whose `subagent_type` takes a place ({@link placeTakingAgentTypes})
 *   admits it: one place for the worker, and one more for its coordinator (the session and the
 *   dispatching agent) when that coordinator holds none. Both are taken at once or not at all, so
 *   coordinators that wait never hold a place while they wait. At the cap the hook waits, in
 *   arrival order, up to {@link placeWaitLimitMilliseconds}, then denies the call with the holders
 *   and the instruction to retry later. Read-only agent types take no place.
 * - `SubagentStart` binds the worker's place to its agent id, and so does `PostToolUse` when the
 *   call moved to the background. `SubagentStop`, a completed foreground `PostToolUse` and
 *   `PostToolUseFailure` release it. A coordinator's place goes once it has no worker left.
 * - {@link capBypassVariable}, set in the session's environment to text a dispatch's description or
 *   prompt contains (its issue, say), admits that dispatch at once, past the cap, and says so.
 *
 * Usage: `bun scripts/host-sessions.ts status` lists the places and waiters;
 * `bun scripts/host-sessions.ts hook` is the hook, reading its input from standard input.
 * `--directory=<path>` uses another places directory, for a check by hand.
 */

import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  isHolderAlive,
  readProcessTable,
  type ProcessEntry,
  type ProcessTable,
} from './bun-test-pool.ts';
import { rootScriptEnvironment } from './environment-configuration.ts';
import {
  ancestorsOf,
  enqueue,
  gitCommonDirectory,
  ownerFileName,
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

/** Set to text in one dispatch's description or prompt to admit that dispatch past the cap. */
export const capBypassVariable = 'CORVIDAE_AGENT_CAP_BYPASS';

/** The agent types that take a place. Every other type, `chef-reviewer` and Explore among them, takes none. */
export const placeTakingAgentTypes: ReadonlySet<string> = new Set(['chef-worker']);

/** The places directory's name in the Git common directory. */
export const placesDirectoryName = 'corvidae-agent-places';

export type PlaceRecord = OwnerRecord & {
  readonly kind: 'worker' | 'coordinator';
  readonly sessionId: string;
  /** The agent that dispatched the worker, empty for the session's main agent. */
  readonly dispatcher: string;
  readonly toolUseId?: string;
  readonly agentId?: string;
  /** The issue the dispatch names, when it names one. */
  readonly issue?: string;
  readonly bypass?: boolean;
};

export type Place = { readonly directory: string; readonly record: PlaceRecord };

type ProcessIdentity = { readonly pid: number; readonly pidStartedAt?: string };

const placeName = /^(?:place-\d+|bypass-[\w-]+)$/;
const ticketSuffix = '.json';
const boundMarker = 'bound';

function queueDirectory(directory: string): string {
  return join(directory, 'queue');
}

function placeDirectory(directory: string, index: number): string {
  return join(directory, `place-${index}`);
}

/** Every place record, in name order, and the place directories that hold none. */
async function readPlaceDirectories(
  directory: string,
): Promise<{ places: Place[]; garbage: string[] }> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const places: Place[] = [];
  const garbage: string[] = [];
  for (const name of names.filter((entry) => placeName.test(entry)).toSorted()) {
    const path = join(directory, name);
    const record = (await readOwner(path)) as PlaceRecord | undefined;
    if (record === undefined) garbage.push(path);
    else places.push({ directory: path, record });
  }
  return { places, garbage };
}

/** Every readable place record, without judging or changing any. */
export async function readPlaces(directory: string): Promise<Place[]> {
  const { places } = await readPlaceDirectories(directory);
  return places;
}

function samePair(a: PlaceRecord, b: { sessionId: string; dispatcher: string }): boolean {
  return a.sessionId === b.sessionId && a.dispatcher === b.dispatcher;
}

/**
 * Why a place no longer counts: its holder process is gone, or it is a coordinator's with no
 * worker left. Undefined while it counts. A table that cannot be read judges every holder alive.
 */
export function reclaimableBecause(
  place: Place,
  places: readonly Place[],
  table: ProcessTable | undefined,
): string | undefined {
  if (table !== undefined && !isHolderAlive(place.record, table)) return 'its session has exited';
  if (place.record.kind !== 'coordinator') return undefined;
  const hasWorker = places.some(
    (other) =>
      other.record.kind === 'worker' &&
      samePair(other.record, place.record) &&
      (table === undefined || isHolderAlive(other.record, table)),
  );
  return hasWorker ? undefined : 'it has no worker left';
}

/**
 * The places that count, after reclaiming the rest (see {@link reclaimableBecause}). Only the
 * waiter at the front of the queue calls it, so a reclaim never races an install.
 */
export async function surveyPlaces(
  directory: string,
  table: ProcessTable | undefined,
): Promise<Place[]> {
  const { places, garbage } = await readPlaceDirectories(directory);
  for (const path of garbage) await rm(path, { recursive: true, force: true });
  const kept: Place[] = [];
  for (const place of places) {
    if (reclaimableBecause(place, places, table) === undefined) kept.push(place);
    else await removeLock(place.directory, place.record);
  }
  return kept;
}

function age(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 120) return `${seconds}s`;
  const whole = Math.round(seconds / 60);
  return whole < 120 ? `${whole}m` : `${Math.floor(whole / 60)}h${whole % 60}m`;
}

/** One line naming a place's holder: what it is, its session, its issue, and its age. */
export function describePlace(record: PlaceRecord, now: number): string {
  const session = `session ${record.sessionId.slice(0, 8)}`;
  const dispatcher = record.dispatcher === '' ? 'main agent' : `agent ${record.dispatcher}`;
  const held = `held ${age(now - Date.parse(record.acquiredAt))}`;
  const what =
    record.kind === 'coordinator'
      ? `coordinator (${session}, ${dispatcher})`
      : `worker ${record.issue ?? 'without an issue'} "${record.command}" (${session}, dispatched by ${dispatcher}${record.bypass ? ', past the cap' : ''})`;
  return `${what}, ${held}, by pid ${record.pid} in ${record.cwd}`;
}

/**
 * The places as lines: a summary, then one line per place, marking those the next waiter reclaims.
 */
export function describePlaces(
  places: readonly Place[],
  cap: number,
  now: number,
  table: ProcessTable | undefined,
): string[] {
  const reasons = places.map((place) => reclaimableBecause(place, places, table));
  const held = reasons.filter((reason) => reason === undefined).length;
  return [
    `${held} of ${cap} host places held`,
    ...places.map((place, index) => {
      const reason = reasons[index];
      const note = reason === undefined ? '' : ` (reclaimable: ${reason})`;
      return `  ${describePlace(place.record, now)}${note}`;
    }),
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

async function tickets(queue: string): Promise<string[]> {
  const names = await readdir(queue).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith(ticketSuffix)).toSorted();
}

/** The oldest live ticket, after pruning the dead ones ahead of it: `own` once none is left ahead. */
async function liveFront(queue: string, own: string, table: ProcessTable | undefined) {
  for (const name of await tickets(queue)) {
    if (name === own || ticketLive(await readTicket(queue, name), table)) return name;
    await rm(join(queue, name), { force: true });
  }
  return own;
}

/** The waiters in arrival order, as lines. */
export async function describeWaiters(directory: string): Promise<string[]> {
  const queue = queueDirectory(directory);
  const lines: string[] = [];
  for (const name of await tickets(queue)) {
    const waiter = await readTicket(queue, name);
    if (waiter !== undefined) lines.push(`  waiting: ${waiter.command}, pid ${waiter.pid}`);
  }
  return lines;
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
  readonly cap?: number;
  readonly waitLimitMilliseconds?: number;
  readonly pollIntervalMilliseconds?: number;
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

function recordFor(
  request: PlaceRequest,
  kind: PlaceRecord['kind'],
  acquiredAt: string,
  bypass: boolean,
): PlaceRecord {
  return {
    pid: request.holder.pid,
    ...(request.holder.pidStartedAt === undefined
      ? {}
      : { pidStartedAt: request.holder.pidStartedAt }),
    command: kind === 'worker' ? request.description : 'coordinator',
    cwd: request.cwd,
    acquiredAt,
    token: crypto.randomUUID(),
    kind,
    sessionId: request.sessionId,
    dispatcher: request.dispatcher,
    ...(kind === 'worker' ? { toolUseId: request.toolUseId } : {}),
    ...(kind === 'worker' && request.issue !== undefined ? { issue: request.issue } : {}),
    ...(bypass ? { bypass } : {}),
  };
}

/** Installs every record in a free place, or none: a partial claim is given back. */
async function claimPlaces(
  directory: string,
  free: readonly number[],
  records: readonly PlaceRecord[],
): Promise<boolean> {
  const installed: Array<{ path: string; record: PlaceRecord }> = [];
  const pending = [...records];
  for (const index of free) {
    const record = pending[0];
    if (record === undefined) break;
    const path = placeDirectory(directory, index);
    if (await tryInstall(path, record)) {
      installed.push({ path, record });
      pending.shift();
    }
  }
  if (pending.length === 0) return true;
  await Promise.all(installed.map(({ path, record }) => removeLock(path, record)));
  return false;
}

/**
 * Waits, in arrival order, until the dispatch holds a place for its worker and one for its
 * coordinator when that coordinator holds none, or until the wait limit passes.
 */
export async function admitWorker(input: AdmitOptions): Promise<Admission> {
  // Snapshotted, so a caller that changes its options after an await cannot change this dispatch.
  const options = { ...input };
  const request: PlaceRequest = { ...input.request };
  const { directory, now } = options;
  const cap = options.cap ?? hostPlaceCap;
  const limit = options.waitLimitMilliseconds ?? placeWaitLimitMilliseconds;
  const started = now();
  const acquiredAt = () => new Date(now()).toISOString();
  await mkdir(directory, { recursive: true });
  if (options.bypass === true) {
    const record = recordFor(request, 'worker', acquiredAt(), true);
    await tryInstall(join(directory, `bypass-${record.token}`), record);
    return { admitted: true, bypassed: true, waitedMilliseconds: 0 };
  }
  const queue = queueDirectory(directory);
  const ticket = await enqueue(queue, {
    pid: request.waiter.pid,
    ...(request.waiter.pidStartedAt === undefined
      ? {}
      : { pidStartedAt: request.waiter.pidStartedAt }),
    command: `worker ${request.issue ?? 'without an issue'} "${request.description}" (session ${request.sessionId.slice(0, 8)})`,
    cwd: request.cwd,
    acquiredAt: acquiredAt(),
    token: crypto.randomUUID(),
  });
  let heldWhenWaiting: string[] | undefined;
  try {
    for (;;) {
      const table = options.readProcessTable();
      const front = (await liveFront(queue, ticket, table)) === ticket;
      const places = front ? await surveyPlaces(directory, table) : await readPlaces(directory);
      if (front) {
        const coordinatorHeld = places.some(
          (place) => place.record.kind === 'coordinator' && samePair(place.record, request),
        );
        const records = [recordFor(request, 'worker', acquiredAt(), false)];
        if (!coordinatorHeld) records.push(recordFor(request, 'coordinator', acquiredAt(), false));
        const taken = new Set(places.map((place) => place.directory));
        const free = Array.from({ length: cap }, (_, index) => index).filter(
          (index) => !taken.has(placeDirectory(directory, index)),
        );
        if (
          places.length + records.length <= cap &&
          (await claimPlaces(directory, free, records))
        ) {
          return {
            admitted: true,
            bypassed: false,
            waitedMilliseconds: now() - started,
            ...(heldWhenWaiting === undefined ? {} : { heldWhenWaiting }),
          };
        }
      }
      const held = describePlaces(places, cap, now(), table);
      heldWhenWaiting ??= held;
      const waitedMilliseconds = now() - started;
      if (waitedMilliseconds >= limit) return { admitted: false, waitedMilliseconds, held };
      await options.sleep(options.pollIntervalMilliseconds ?? placePollIntervalMilliseconds);
    }
  } finally {
    await rm(join(queue, ticket), { force: true });
  }
}

/** Writes a place's owner file in one rename, so a reader never sees it half-written. */
async function rewritePlace(place: Place, record: PlaceRecord): Promise<void> {
  const staged = join(place.directory, `${ownerFileName}.${record.token}.${crypto.randomUUID()}`);
  await writeFile(staged, JSON.stringify(record));
  await rename(staged, join(place.directory, ownerFileName));
}

/** Marks a place bound; only the first caller succeeds, so two binders never share one place. */
async function markBound(place: Place): Promise<boolean> {
  try {
    await mkdir(join(place.directory, boundMarker));
    return true;
  } catch {
    return false;
  }
}

/** Binds the oldest unbound worker place `match` selects to `agentId`; false when none was bound. */
export async function bindAgent(
  directory: string,
  agentId: string,
  match: (record: PlaceRecord) => boolean,
): Promise<boolean> {
  const all = await readPlaces(directory);
  const places = all
    .filter(
      (place) =>
        place.record.kind === 'worker' && place.record.agentId === undefined && match(place.record),
    )
    .toSorted((a, b) => a.record.acquiredAt.localeCompare(b.record.acquiredAt));
  for (const place of places) {
    if (await markBound(place)) {
      await rewritePlace(place, { ...place.record, agentId });
      return true;
    }
  }
  return false;
}

/**
 * Releases the worker places `match` selects; resolves to how many. A coordinator's place left
 * with no worker stops counting at once and is removed by the next waiter's survey, so a release
 * never races a dispatch that counted on it.
 */
export async function releaseWorkers(
  directory: string,
  match: (record: PlaceRecord) => boolean,
): Promise<number> {
  const all = await readPlaces(directory);
  const places = all.filter((place) => place.record.kind === 'worker' && match(place.record));
  for (const place of places) await removeLock(place.directory, place.record);
  return places.length;
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
  if (!placeTakingAgentTypes.has(text(field(toolInput, 'subagent_type')))) return undefined;
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
  const limit = context.waitLimitMilliseconds ?? placeWaitLimitMilliseconds;
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
    cap,
    waitLimitMilliseconds: limit,
    bypass,
  });
  if (!admission.admitted) {
    const reason = [
      `Host place cap: this ${[...placeTakingAgentTypes].join('/')} dispatch waited ${minutes(admission.waitedMilliseconds)} for one of the host's ${cap} places for implementation workers and their coordinators (AGENTS.md "Parallel runs"), and none came free. The places:`,
      ...admission.held,
      `Retry the dispatch later, once a holder finishes; \`bun scripts/host-sessions.ts status\` lists the holders. On the owner's instruction only, a session started with ${capBypassVariable} set to text in a dispatch's description or prompt, such as its issue, admits that dispatch past the cap.`,
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

/** The hook's answer to one event, after acting on the places; undefined to print nothing. */
export async function handleHookEvent(
  input: HookInput,
  context: HookContext,
): Promise<HookOutput | undefined> {
  const event = text(input.hook_event_name);
  const sessionId = text(input.session_id);
  const toolUseId = text(input.tool_use_id);
  const isAgentCall =
    text(input.tool_name) === 'Agent' &&
    placeTakingAgentTypes.has(text(field(input.tool_input, 'subagent_type')));
  if (event === 'PreToolUse' && text(input.tool_name) === 'Agent') {
    return admitDispatch(input, context);
  }
  if (event === 'SubagentStart' && placeTakingAgentTypes.has(text(input.agent_type))) {
    await bindAgent(
      context.directory,
      text(input.agent_id),
      (record) => record.sessionId === sessionId,
    );
  } else if (event === 'SubagentStop' && placeTakingAgentTypes.has(text(input.agent_type))) {
    const agentId = text(input.agent_id);
    if (agentId !== '')
      await releaseWorkers(context.directory, (record) => record.agentId === agentId);
  } else if (event === 'PostToolUse' && isAgentCall && toolUseId !== '') {
    const status = text(field(input.tool_response, 'status'));
    const agentId = text(field(input.tool_response, 'agentId'));
    if (status === 'completed') {
      await releaseWorkers(context.directory, (record) => record.toolUseId === toolUseId);
    } else if (status === 'async_launched' && agentId !== '') {
      await bindAgent(context.directory, agentId, (record) => record.toolUseId === toolUseId);
    }
  } else if (event === 'PostToolUseFailure' && isAgentCall && toolUseId !== '') {
    await releaseWorkers(context.directory, (record) => record.toolUseId === toolUseId);
  }
  return undefined;
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
    ...describePlaces(await readPlaces(directory), hostPlaceCap, Date.now(), readProcessTable()),
    ...(await describeWaiters(directory)),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (import.meta.main) {
  const [command, ...rest] = Bun.argv.slice(2);
  if (command === 'hook') await runHook(rest);
  else if (command === 'status') await printStatus(rest);
  else {
    process.stderr.write('Usage: bun scripts/host-sessions.ts status|hook [--directory=<path>]\n');
    process.exitCode = 64;
  }
}
