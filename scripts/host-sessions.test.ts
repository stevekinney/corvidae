import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProcessEntry, ProcessTable } from './bun-test-pool.ts';
import { neverStartedLimitMilliseconds, workerPlaces } from './host-sessions-model.ts';
import {
  admitWorker,
  appendEvent,
  capBypassVariable,
  describePlaces,
  handleHookEvent,
  hostPlaceCap,
  hostPlaces,
  placePollIntervalMilliseconds,
  placeWaitLimitMilliseconds,
  readSessions,
  releasePlace,
  sessionProcess,
  startSessionToolName,
  type AdmitOptions,
  type HookContext,
  type HookInput,
  type PlaceRequest,
} from './host-sessions.ts';
import { enqueue } from './run-exclusively.ts';

/**
 * Every scenario owns a scratch places directory, judges liveness from an injected process table,
 * and waits on an injected clock: `sleep` advances it, so a twenty-minute wait takes no time.
 */
const scratchDirectories: string[] = [];

afterAll(async () => {
  for (const directory of scratchDirectories) await rm(directory, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-agent-places-'));
  scratchDirectories.push(directory);
  return join(directory, 'places');
}

const desktop = '/Applications/Claude.app/Contents/MacOS/Claude';
const claude =
  '/Users/someone/Library/Application Support/Claude/claude-code/2.1.321/claude.app/Contents/MacOS/claude --output-format stream-json';

function entry(parent: number, command: string): ProcessEntry {
  return {
    parent,
    processGroup: parent,
    startedAt: `started ${parent} ${command.length}`,
    command,
  };
}

/** A host with two sessions, each running its hooks through a shell: session A (pid 400), B (500). */
function hostTable(extra: ReadonlyArray<[number, ProcessEntry]> = []): Map<number, ProcessEntry> {
  return new Map<number, ProcessEntry>([
    [100, entry(1, desktop)],
    [300, entry(100, `/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- ${claude}`)],
    [400, entry(300, claude)],
    [410, entry(400, '/bin/sh -c bun "$CLAUDE_PROJECT_DIR"/scripts/host-sessions.ts hook')],
    [411, entry(410, 'bun /repository/scripts/host-sessions.ts hook')],
    [500, entry(300, claude)],
    [510, entry(500, '/bin/sh -c bun "$CLAUDE_PROJECT_DIR"/scripts/host-sessions.ts hook')],
    [511, entry(510, 'bun /repository/scripts/host-sessions.ts hook')],
    ...extra,
  ]);
}

function request(session: 'A' | 'B', toolUseId: string, overrides: Partial<PlaceRequest> = {}) {
  const pid = session === 'A' ? 400 : 500;
  const table = hostTable();
  return {
    sessionId: `session-${session}`,
    dispatcher: '',
    toolUseId,
    description: `Deliver COR-${toolUseId}`,
    issue: `COR-${toolUseId}`,
    cwd: `/worktrees/${session}`,
    holder: { pid, pidStartedAt: table.get(pid)?.startedAt ?? '' },
    waiter: { pid: pid + 11, pidStartedAt: table.get(pid + 11)?.startedAt ?? '' },
    ...overrides,
  } satisfies PlaceRequest;
}

function clock(start = 1_000_000) {
  const state = { now: start, sleeps: 0 };
  return {
    state,
    now: () => state.now,
    sleep: async (milliseconds: number) => {
      state.sleeps += 1;
      state.now += milliseconds;
    },
  };
}

async function places(directory: string): Promise<number> {
  return hostPlaces(await readSessions(directory));
}

async function sessionIds(directory: string): Promise<string[]> {
  const ledgers = await readSessions(directory);
  return ledgers.map((ledger) => ledger.sessionId);
}

async function workersOf(directory: string, sessionId: string): Promise<number> {
  const ledgers = await readSessions(directory);
  const ledger = ledgers.find((each) => each.sessionId === sessionId);
  return ledger === undefined ? 0 : workerPlaces(ledger.state);
}

function context(directory: string, overrides: Partial<HookContext> = {}): HookContext {
  const time = clock();
  return {
    directory,
    hookPid: 411,
    environment: {},
    readProcessTable: () => hostTable(),
    now: time.now,
    sleep: time.sleep,
    ...overrides,
  };
}

function dispatch(
  subagentType: string,
  toolUseId: string,
  description = 'Deliver COR-1',
): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'session-A',
    tool_name: 'Agent',
    tool_use_id: toolUseId,
    cwd: '/worktrees/A',
    tool_input: { subagent_type: subagentType, description, prompt: 'Implement it.' },
  };
}

function agentEvent(name: string, agentId: string, agentType = 'chef-worker'): HookInput {
  return {
    hook_event_name: name,
    session_id: 'session-A',
    agent_id: agentId,
    agent_type: agentType,
  };
}

function toolResult(toolUseId: string, status: string, agentId: string): HookInput {
  return {
    hook_event_name: 'PostToolUse',
    session_id: 'session-A',
    tool_name: 'Agent',
    tool_use_id: toolUseId,
    tool_input: { subagent_type: 'chef-worker' },
    tool_response: { status, agentId },
  };
}

describe('sessionProcess', () => {
  test('is the claude process above a shell-form hook, never the desktop application', () => {
    expect(sessionProcess(411, hostTable())).toBe(400);
  });

  test('is the claude process above an exec-form hook', () => {
    const table = hostTable([[420, entry(400, 'bun /repository/scripts/host-sessions.ts hook')]]);
    expect(sessionProcess(420, table)).toBe(400);
  });

  test('falls back to the nearest ancestor that is not a shell or Bun', () => {
    const table: ProcessTable = new Map([
      [100, entry(1, desktop)],
      [200, entry(100, '/Users/someone/.local/share/claude/versions/2.1.321 --resume')],
      [210, entry(200, '/bin/zsh -c bun hook')],
      [211, entry(210, 'bun /repository/scripts/host-sessions.ts hook')],
    ]);
    expect(sessionProcess(211, table)).toBe(200);
    const orphaned: ProcessTable = new Map([
      [100, entry(1, desktop)],
      [210, entry(100, '/bin/zsh -c bun hook')],
      [211, entry(210, 'bun /repository/scripts/host-sessions.ts hook')],
    ]);
    expect(sessionProcess(211, orphaned)).toBeUndefined();
  });
});

describe('admitWorker', () => {
  function options(directory: string, time: ReturnType<typeof clock>) {
    return { directory, readProcessTable: () => hostTable(), now: time.now, sleep: time.sleep };
  }

  test('admits at once while places are free, with a place for the coordinator the first time', async () => {
    const directory = await scratch();
    const time = clock();
    const first = await admitWorker({ ...options(directory, time), request: request('A', '1') });
    expect(first).toEqual({ admitted: true, bypassed: false, waitedMilliseconds: 0 });
    expect(await places(directory)).toBe(2);
    const second = await admitWorker({ ...options(directory, time), request: request('A', '2') });
    expect(second.admitted).toBe(true);
    expect(await places(directory)).toBe(3);
    expect(time.state.sleeps).toBe(0);
    expect(await readdir(join(directory, 'queue'))).toEqual([]);
  });

  test('a main agent and its subagent that both dispatch hold one coordinator place', async () => {
    const directory = await scratch();
    const time = clock();
    await admitWorker({ ...options(directory, time), request: request('A', '1') });
    const nested = await admitWorker({
      ...options(directory, time),
      request: request('A', '2', { dispatcher: 'agent-coordinator' }),
    });
    expect(nested.admitted).toBe(true);
    expect(await places(directory)).toBe(3);
  });

  test('tells the holders when the wait starts, then admits once a holder stops', async () => {
    const directory = await scratch();
    const time = clock();
    await admitWorker({ ...options(directory, time), request: request('A', '1') });
    const reports: string[][] = [];
    let stopped = false;
    const admission = await admitWorker({
      ...options(directory, time),
      request: request('B', '2'),
      report: (lines) => reports.push([...lines]),
      // Session B needs a worker's place and a coordinator's: 2 + 2 is over the cap until A's
      // worker ends, which ends A's coordinator place too.
      sleep: async (milliseconds) => {
        expect(reports).toHaveLength(1);
        await time.sleep(milliseconds);
        if (!stopped) {
          stopped = true;
          await handleHookEvent(
            { ...dispatch('chef-worker', '1'), hook_event_name: 'PostToolUseFailure' },
            context(directory),
          );
        }
      },
    });
    expect(admission.admitted).toBe(true);
    if (!admission.admitted) throw new Error('unreachable');
    expect(admission.waitedMilliseconds).toBe(placePollIntervalMilliseconds);
    expect(reports[0]?.[0]).toBe(`2 of ${hostPlaceCap} host places held`);
    expect(reports[0]?.join('\n')).toContain('worker COR-1 "Deliver COR-1"');
    expect(admission.heldWhenWaiting).toEqual(reports[0]);
    expect(await workersOf(directory, 'session-A')).toBe(0);
    expect(await workersOf(directory, 'session-B')).toBe(1);
  });

  test('waits up to the limit, then refuses with the holders and leaves no ticket', async () => {
    const directory = await scratch();
    const time = clock();
    await admitWorker({ ...options(directory, time), request: request('A', '1') });
    await admitWorker({ ...options(directory, time), request: request('A', '2') });
    // Both workers run, so the wait outlasts the never-started limit without reclaiming them.
    await handleHookEvent(agentEvent('SubagentStart', 'agent-1'), context(directory));
    await handleHookEvent(agentEvent('SubagentStart', 'agent-2'), context(directory));
    const admission = await admitWorker({
      ...options(directory, time),
      request: request('B', '3'),
    });
    expect(admission.admitted).toBe(false);
    if (admission.admitted) throw new Error('unreachable');
    expect(admission.waitedMilliseconds).toBe(placeWaitLimitMilliseconds);
    expect(time.state.sleeps).toBe(placeWaitLimitMilliseconds / placePollIntervalMilliseconds);
    expect(admission.held[0]).toBe('3 of 3 host places held');
    expect(admission.held.join('\n')).toContain('session session-');
    expect(await places(directory)).toBe(3);
    expect(await readdir(join(directory, 'queue'))).toEqual([]);
  });

  test("admits the active coordinator's second worker while an older waiter needing two places waits", async () => {
    const directory = await scratch();
    const time = clock();
    await admitWorker({ ...options(directory, time), request: request('A', '1') });
    // Session B's dispatch waits, live, ahead in the queue: it needs two places, and one is free.
    const waiting = { pid: 511, pidStartedAt: hostTable().get(511)?.startedAt ?? '' };
    await enqueue(join(directory, 'queue'), {
      ...waiting,
      command: 'session B waiting',
      cwd: '/worktrees/B',
      acquiredAt: '',
      token: 'waiting-b',
      sessionId: 'session-B',
    } as Parameters<typeof enqueue>[1]);
    const second = await admitWorker({ ...options(directory, time), request: request('A', '2') });
    expect(second).toEqual({ admitted: true, bypassed: false, waitedMilliseconds: 0 });
    expect(await places(directory)).toBe(3);
  });

  test('reclaims a session whose process is gone on the next acquire', async () => {
    const directory = await scratch();
    const time = clock();
    await admitWorker({
      ...options(directory, time),
      request: request('B', '1', { holder: { pid: 999_999, pidStartedAt: 'gone' } }),
    });
    await admitWorker({ ...options(directory, time), request: request('A', '2'), cap: 2 });
    expect(await sessionIds(directory)).toEqual(['session-A']);
    // A recycled pid is not the holder: the start time decides.
    const recycled = hostTable([[400, { ...entry(300, claude), startedAt: 'a later start' }]]);
    const admission = await admitWorker({
      ...options(directory, time),
      readProcessTable: () => recycled,
      cap: 2,
      request: request('B', '3', {
        holder: { pid: 500, pidStartedAt: recycled.get(500)?.startedAt ?? '' },
      }),
    });
    expect(admission.admitted).toBe(true);
    expect(await sessionIds(directory)).toEqual(['session-B']);
  });

  test('an admitted dispatch with no start is shown as never started after the limit, then reclaimed on the next acquire', async () => {
    const directory = await scratch();
    const time = clock();
    await admitWorker({ ...options(directory, time), request: request('A', '1') });
    await admitWorker({ ...options(directory, time), request: request('A', '2') });
    await handleHookEvent(agentEvent('SubagentStart', 'agent-2'), context(directory));
    const shown = () =>
      readSessions(directory).then((ledgers) =>
        describePlaces(ledgers, hostPlaceCap, time.now(), hostTable()).join('\n'),
      );
    expect(await shown()).toContain('no agent started yet');
    time.state.now += neverStartedLimitMilliseconds;
    // The newest unstarted admission is the one shown: the start went to the oldest.
    expect(await shown()).toContain(
      'dispatch 2, admitted 10m ago, admitted, never started (reclaimed by the next dispatch)',
    );
    const admission = await admitWorker({
      ...options(directory, time),
      request: request('B', '3'),
      waitLimitMilliseconds: 0,
    });
    // The anonymous start could belong to either dispatch, so neither can be reclaimed without a
    // link. A therefore holds both worker places and B still waits past the cap of 3.
    expect(admission.admitted).toBe(false);
    expect(await workersOf(directory, 'session-A')).toBe(2);
    expect(await places(directory)).toBe(3);
  });

  test('skips a dead waiter ahead in the queue', async () => {
    const directory = await scratch();
    const time = clock();
    const queue = join(directory, 'queue');
    await mkdir(queue, { recursive: true });
    await Bun.write(
      join(queue, '0000000000000001-dead.json'),
      JSON.stringify({ pid: 999_998, command: 'dead', cwd: '/', acquiredAt: '', token: 'dead' }),
    );
    const admission = await admitWorker({
      ...options(directory, time),
      request: request('A', '1'),
    });
    expect(admission.admitted).toBe(true);
    expect(time.state.sleeps).toBe(0);
    expect(await readdir(queue)).toEqual([]);
  });

  test('a lock left by a hook that died is removed, and one held by a live hook is waited for', async () => {
    const directory = await scratch();
    const time = clock();
    await mkdir(directory, { recursive: true });
    const { tryInstall, removeLock } = await import('./run-exclusively.ts');
    const dead = { pid: 999_997, command: 'dead hook', cwd: '/', acquiredAt: '', token: 'dead' };
    expect(await tryInstall(join(directory, 'admission'), dead)).toBe(true);
    const admitted = await admitWorker({ ...options(directory, time), request: request('A', '1') });
    expect(admitted.admitted).toBe(true);
    const live = {
      pid: 511,
      pidStartedAt: hostTable().get(511)?.startedAt ?? '',
      command: 'live',
      cwd: '/',
      acquiredAt: '',
      token: 'live',
    };
    expect(await tryInstall(join(directory, 'admission'), live)).toBe(true);
    let waits = 0;
    const second = await admitWorker({
      ...options(directory, time),
      request: request('A', '2'),
      sleep: async (milliseconds) => {
        waits += 1;
        await time.sleep(milliseconds);
        if (waits === 2) await removeLock(join(directory, 'admission'), live);
      },
    } satisfies AdmitOptions);
    expect(second.admitted).toBe(true);
    expect(waits).toBe(2);
  });

  test('hooks that meet one abandoned lock together reclaim it once and strand no live lock', async () => {
    const directory = await scratch();
    await mkdir(directory, { recursive: true });
    const { tryInstall } = await import('./run-exclusively.ts');
    const dead = { pid: 999_997, command: 'dead hook', cwd: '/', acquiredAt: '', token: 'dead' };
    expect(await tryInstall(join(directory, 'admission'), dead)).toBe(true);
    const toolUseIds = Array.from({ length: 12 }, (_, index) => String(index + 1));
    const admissions = await Promise.all(
      toolUseIds.map((toolUseId) =>
        admitWorker({
          ...options(directory, clock()),
          cap: 100,
          // The injected clock advances on every wait, so a contender under load must not lose to it.
          waitLimitMilliseconds: Number.POSITIVE_INFINITY,
          request: request('A', toolUseId),
        }),
      ),
    );
    expect(admissions.every((each) => each.admitted)).toBe(true);
    const names = await readdir(directory);
    expect(names.filter((name) => name.startsWith('admission'))).toEqual([]);
  });
});

describe('the hook', () => {
  test('read-only agent types take no host place, and every other type takes one', async () => {
    const directory = await scratch();
    // A type is read-only when its definition lists neither Edit nor Write; with no definition,
    // only the built-in read-only types (Explore) are.
    const tools: Record<string, string> = {
      'chef-reviewer': 'Read, Grep, Glob, Bash',
      'design-reviewer': 'Read, Grep, Glob, Bash',
      reenactor: 'Read, Grep, Glob, Bash, Edit, Write',
    };
    const readAgentTools = (type: string) => tools[type];
    for (const type of ['chef-reviewer', 'design-reviewer', 'Explore']) {
      expect(
        await handleHookEvent(dispatch(type, `t-${type}`), context(directory, { readAgentTools })),
      ).toBeUndefined();
    }
    expect(await places(directory)).toBe(0);
    for (const type of ['reenactor', 'general-purpose']) {
      await handleHookEvent(
        dispatch(type, `t-${type}`),
        context(directory, { readAgentTools, cap: 20 }),
      );
    }
    expect(await workersOf(directory, 'session-A')).toBe(2);
    expect(await places(directory)).toBe(3);
  });

  test('read-only agents are capped at six together, and the seventh waits', async () => {
    const directory = await scratch();
    const limits = { waitLimitMilliseconds: 30_000 };
    for (const index of [1, 2, 3, 4, 5, 6]) {
      expect(
        await handleHookEvent(dispatch('Explore', `scout-${index}`), context(directory, limits)),
      ).toBeUndefined();
    }
    const seventh = await handleHookEvent(
      dispatch('Explore', 'scout-7'),
      context(directory, limits),
    );
    expect(seventh?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(seventh?.hookSpecificOutput?.permissionDecisionReason).toContain('read-only');
    // Implementation agents are not held back by the read-only cap.
    expect(
      await handleHookEvent(dispatch('chef-worker', 'worker-1'), context(directory, limits)),
    ).toBeUndefined();
  });

  test('takes places on dispatch, keeps them through the start, and returns them when the worker stops', async () => {
    const directory = await scratch();
    expect(
      await handleHookEvent(dispatch('chef-worker', 'tool-1'), context(directory)),
    ).toBeUndefined();
    expect(await places(directory)).toBe(2);
    await handleHookEvent(agentEvent('SubagentStart', 'agent-1'), context(directory));
    expect(await places(directory)).toBe(2);
    // A stop of an agent never started here returns nothing.
    await handleHookEvent(agentEvent('SubagentStop', 'agent-9'), context(directory));
    expect(await places(directory)).toBe(2);
    await handleHookEvent(agentEvent('SubagentStop', 'agent-1'), context(directory));
    await handleHookEvent(agentEvent('SubagentStop', 'agent-1'), context(directory));
    expect(await places(directory)).toBe(0);
  });

  test('two background workers whose second starts first keep the first counted after the second stops', async () => {
    const directory = await scratch();
    await handleHookEvent(dispatch('chef-worker', 'tool-a'), context(directory));
    await handleHookEvent(dispatch('chef-worker', 'tool-b'), context(directory));
    await handleHookEvent(agentEvent('SubagentStart', 'agent-b'), context(directory));
    await handleHookEvent(toolResult('tool-b', 'async_launched', 'agent-b'), context(directory));
    await handleHookEvent(agentEvent('SubagentStart', 'agent-a'), context(directory));
    await handleHookEvent(agentEvent('SubagentStop', 'agent-b'), context(directory));
    expect(await places(directory)).toBe(2);
  });

  test('two background workers launched in order keep the second counted after the first stops', async () => {
    const directory = await scratch();
    await handleHookEvent(dispatch('chef-worker', 'tool-a'), context(directory));
    await handleHookEvent(dispatch('chef-worker', 'tool-b'), context(directory));
    await handleHookEvent(toolResult('tool-a', 'async_launched', 'agent-a'), context(directory));
    await handleHookEvent(agentEvent('SubagentStart', 'agent-a'), context(directory));
    await handleHookEvent(toolResult('tool-b', 'async_launched', 'agent-b'), context(directory));
    await handleHookEvent(agentEvent('SubagentStart', 'agent-b'), context(directory));
    await handleHookEvent(agentEvent('SubagentStop', 'agent-a'), context(directory));
    expect(await places(directory)).toBe(2);
  });

  test('a completed foreground call, a failed one and a denied one each return their place once', async () => {
    const directory = await scratch();
    await handleHookEvent(dispatch('chef-worker', 'tool-1'), context(directory));
    await handleHookEvent(dispatch('chef-worker', 'tool-2'), context(directory));
    await handleHookEvent(agentEvent('SubagentStart', 'agent-1'), context(directory));
    // The foreground call returns with no SubagentStop (an API error fires StopFailure instead).
    await handleHookEvent(toolResult('tool-1', 'completed', 'agent-1'), context(directory));
    expect(await workersOf(directory, 'session-A')).toBe(1);
    await handleHookEvent(
      { ...dispatch('chef-worker', 'tool-2'), hook_event_name: 'PermissionDenied' },
      context(directory),
    );
    await handleHookEvent(
      { ...dispatch('chef-worker', 'tool-2'), hook_event_name: 'PostToolUseFailure' },
      context(directory),
    );
    expect(await places(directory)).toBe(0);
  });

  test('a start in a session resumed in a new process drops what the old process ran', async () => {
    const directory = await scratch();
    const time = clock();
    await admitWorker({
      directory,
      readProcessTable: () => hostTable(),
      ...time,
      request: request('A', '1', { holder: { pid: 999_999, pidStartedAt: 'gone' } }),
    });
    await appendEvent(directory, 'session-A', { kind: 'start', agentId: 'agent-old', at: 0 });
    expect(await places(directory)).toBe(2);
    await handleHookEvent(agentEvent('SubagentStart', 'agent-new'), context(directory));
    const [ledger] = await readSessions(directory);
    expect([...(ledger?.state.agents.keys() ?? [])]).toEqual(['agent-new']);
    expect(ledger?.holder?.pid).toBe(400);
  });

  test('StopFailure in a worker returns its place', async () => {
    const directory = await scratch();
    await handleHookEvent(dispatch('chef-worker', 'tool-1'), context(directory));
    await handleHookEvent(agentEvent('SubagentStart', 'agent-1'), context(directory));
    await handleHookEvent(agentEvent('StopFailure', 'agent-1'), context(directory));
    expect(await places(directory)).toBe(0);
  });

  test('an agent resumed after its stop with no place free counts, and status says it is over the cap', async () => {
    const directory = await scratch();
    await handleHookEvent(dispatch('chef-worker', 'tool-1'), context(directory));
    await handleHookEvent(agentEvent('SubagentStart', 'agent-1'), context(directory));
    await handleHookEvent(agentEvent('SubagentStop', 'agent-1'), context(directory));
    const sessionB = { ...dispatch('chef-worker', 'tool-2'), session_id: 'session-B' };
    await handleHookEvent(sessionB, context(directory, { hookPid: 511 }));
    await handleHookEvent(
      { ...dispatch('chef-worker', 'tool-3'), session_id: 'session-B' },
      context(directory, { hookPid: 511 }),
    );
    expect(await places(directory)).toBe(3);
    await handleHookEvent(agentEvent('SubagentStart', 'agent-1'), context(directory));
    expect(await places(directory)).toBe(5);
    const lines = describePlaces(
      await readSessions(directory),
      hostPlaceCap,
      1_000_000,
      hostTable(),
    );
    expect(lines[0]).toBe('5 of 3 host places held, over the cap');
    expect(lines.join('\n')).toContain('resumed (run 2) without an admission, over the cap');
  });

  test('denies at the cap after the wait, naming the holders, the status and release commands and the bypass', async () => {
    const directory = await scratch();
    await handleHookEvent(dispatch('chef-worker', 'tool-1'), context(directory));
    await handleHookEvent(dispatch('chef-worker', 'tool-2'), context(directory));
    await handleHookEvent(agentEvent('SubagentStart', 'agent-1'), context(directory));
    await handleHookEvent(agentEvent('SubagentStart', 'agent-2'), context(directory));
    const reports: string[] = [];
    const output = await handleHookEvent(
      { ...dispatch('chef-worker', 'tool-3', 'Deliver COR-3'), session_id: 'session-B' },
      context(directory, { hookPid: 511, report: (lines) => reports.push(...lines) }),
    );
    expect(output?.hookSpecificOutput?.permissionDecision).toBe('deny');
    const reason = output?.hookSpecificOutput?.permissionDecisionReason ?? '';
    expect(reason).toContain('waited 20 minute(s)');
    expect(reason).toContain('3 of 3 host places held');
    expect(reason).toContain('worker COR-1 "Deliver COR-1"');
    expect(reason).toContain('bun scripts/host-sessions.ts status');
    expect(reason).toContain('bun scripts/host-sessions.ts release');
    expect(reason).toContain(capBypassVariable);
    expect(reports[0]).toContain('this dispatch waits for one of the host');
    expect(await places(directory)).toBe(3);
  });

  test('the bypass variable admits only the dispatch it names, past the cap, and says so', async () => {
    const directory = await scratch();
    await handleHookEvent(dispatch('chef-worker', 'tool-1'), context(directory));
    await handleHookEvent(dispatch('chef-worker', 'tool-2'), context(directory));
    const environment = { [capBypassVariable]: 'COR-9' };
    const named = await handleHookEvent(
      { ...dispatch('chef-worker', 'tool-3', 'Deliver COR-9'), session_id: 'session-B' },
      context(directory, { hookPid: 511, environment }),
    );
    expect(named?.systemMessage).toContain(`${capBypassVariable}=COR-9 admitted this dispatch`);
    expect(named?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    // The bypassed worker and its coordinator both count, past the cap.
    expect(await places(directory)).toBe(5);
    const other = await handleHookEvent(
      { ...dispatch('chef-worker', 'tool-4', 'Deliver COR-10'), session_id: 'session-B' },
      context(directory, { hookPid: 511, environment, waitLimitMilliseconds: 0 }),
    );
    expect(other?.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  test('a session process it cannot find takes no place and says so', async () => {
    const directory = await scratch();
    const output = await handleHookEvent(
      dispatch('chef-worker', 'tool-1'),
      context(directory, { readProcessTable: () => undefined }),
    );
    expect(output?.systemMessage).toContain('took no host place');
    expect(await readSessions(directory)).toEqual([]);
  });

  test('events appended at once each land whole, in one order', async () => {
    const directory = await scratch();
    // An append never creates a ledger; recording the session's holder does, which this skips.
    await mkdir(join(directory, 'sessions', 'session-A'), { recursive: true });
    const appends = Array.from({ length: 20 }, (_, index) =>
      appendEvent(directory, 'session-A', {
        kind: 'admit',
        toolUseId: `tool-${index}`,
        at: index,
        description: '',
        dispatcher: '',
      }),
    );
    await Promise.all(appends);
    const [ledger] = await readSessions(directory);
    expect(ledger?.state.dispatches.size).toBe(20);
    const files = await readdir(join(directory, 'sessions', 'session-A', 'events'));
    expect(files.toSorted()).toEqual(
      Array.from({ length: 20 }, (_, index) => `${String(index + 1).padStart(12, '0')}.json`),
    );
  });
});

describe('every session and every agent counts', () => {
  const startSession = (sessionId: string): HookInput => ({
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    tool_name: 'mcp__ccd_session__start_session',
    tool_use_id: `start-${sessionId}`,
    tool_input: { prompt: 'Take COR-1' },
  });
  const sessionStart = (sessionId: string): HookInput => ({
    hook_event_name: 'SessionStart',
    session_id: sessionId,
    source: 'startup',
    cwd: `/worktrees/${sessionId}`,
  });

  test('a general-purpose dispatch takes a place, like a worker', async () => {
    const directory = await scratch();
    expect(
      await handleHookEvent(dispatch('general-purpose', 'tool-1'), context(directory)),
    ).toBeUndefined();
    expect(await places(directory)).toBe(2);
    await handleHookEvent(
      agentEvent('SubagentStart', 'agent-1', 'general-purpose'),
      context(directory),
    );
    expect(await places(directory)).toBe(2);
    await handleHookEvent(
      agentEvent('SubagentStop', 'agent-1', 'general-purpose'),
      context(directory),
    );
    expect(await places(directory)).toBe(0);
  });

  test('a second Opus agent waits while one runs, from the dispatch model or the agent type', async () => {
    const directory = await scratch();
    const wide = { cap: 10, waitLimitMilliseconds: 60_000 };
    const opus = (toolUseId: string, session: 'A' | 'B', type: string, model?: string) => ({
      ...dispatch(type, toolUseId),
      session_id: `session-${session}`,
      tool_input: {
        subagent_type: type,
        description: `Review ${toolUseId}`,
        prompt: 'Review it.',
        ...(model === undefined ? {} : { model }),
      },
    });
    const readAgentModel = (type: string) => (type === 'chef-reviewer' ? 'opus' : undefined);
    expect(
      await handleHookEvent(
        opus('tool-1', 'A', 'general-purpose', 'opus'),
        context(directory, { ...wide, readAgentModel }),
      ),
    ).toBeUndefined();
    const second = await handleHookEvent(
      opus('tool-2', 'B', 'chef-reviewer'),
      context(directory, { ...wide, hookPid: 511, readAgentModel }),
    );
    expect(second?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(second?.hookSpecificOutput?.permissionDecisionReason).toContain('Opus');
    // A model other than Opus is not held back by the Opus cap.
    expect(
      await handleHookEvent(
        opus('tool-3', 'B', 'general-purpose', 'sonnet'),
        context(directory, { ...wide, hookPid: 511, readAgentModel }),
      ),
    ).toBeUndefined();
  });

  /** Three open sessions: A (pid 400), B (500) and C (700), each registered at its start. */
  const threeSessions = hostTable([
    [700, entry(300, claude)],
    [711, entry(700, 'bun /repository/scripts/host-sessions.ts hook')],
  ]);
  const inSession = (session: 'A' | 'B' | 'C', input: HookInput): HookInput => ({
    ...input,
    session_id: `session-${session}`,
  });
  const asSession = (session: 'A' | 'B' | 'C', overrides: Partial<HookContext> = {}) =>
    context('', {
      hookPid: { A: 411, B: 511, C: 711 }[session],
      readProcessTable: () => threeSessions,
      ...overrides,
    });
  const withDirectory = (directory: string, base: HookContext): HookContext => ({
    ...base,
    directory,
  });
  const readOnlyTools = (type: string) =>
    type === 'chef-reviewer' ? 'Read, Grep, Glob, Bash' : undefined;

  async function registerAll(directory: string): Promise<void> {
    for (const session of ['A', 'B', 'C'] as const) {
      await handleHookEvent(
        inSession(session, sessionStart('x')),
        withDirectory(directory, asSession(session)),
      );
    }
  }

  test('a registered session holds no place, so idle sessions never starve a dispatch', async () => {
    const directory = await scratch();
    await registerAll(directory);
    expect(await places(directory)).toBe(0);
    // Three open sessions, one dispatching: it proceeds, taking its worker and its coordinator.
    const output = await handleHookEvent(
      inSession('A', dispatch('chef-worker', 'tool-1')),
      withDirectory(directory, asSession('A', { cap: 3, waitLimitMilliseconds: 30_000 })),
    );
    expect(output).toBeUndefined();
    expect(await places(directory)).toBe(2);
  });

  test('a coordinator with one worker and one reviewer proceeds beside an idle third session', async () => {
    const directory = await scratch();
    await registerAll(directory);
    const options = { cap: 3, waitLimitMilliseconds: 30_000, readAgentTools: readOnlyTools };
    const worker = await handleHookEvent(
      inSession('A', dispatch('chef-worker', 'tool-1')),
      withDirectory(directory, asSession('A', options)),
    );
    const reviewer = await handleHookEvent(
      inSession('A', dispatch('chef-reviewer', 'tool-2')),
      withDirectory(directory, asSession('A', options)),
    );
    expect([worker, reviewer]).toEqual([undefined, undefined]);
    expect(await places(directory)).toBe(2);
  });

  test('two sessions with one worker each both proceed when the host has room for both', async () => {
    const directory = await scratch();
    await registerAll(directory);
    // Each takes its worker and its coordinator: four places, so a cap of four holds both.
    const options = { cap: 4, waitLimitMilliseconds: 30_000 };
    for (const session of ['A', 'B'] as const) {
      expect(
        await handleHookEvent(
          inSession(session, dispatch('chef-worker', `tool-${session}`)),
          withDirectory(directory, asSession(session, options)),
        ),
      ).toBeUndefined();
    }
    expect(await places(directory)).toBe(4);
  });

  test('a waiting dispatch holds no place: its session is counted only once it is admitted', async () => {
    const directory = await scratch();
    await registerAll(directory);
    const options = { cap: 2, waitLimitMilliseconds: 30_000 };
    await handleHookEvent(
      inSession('A', dispatch('chef-worker', 'tool-1')),
      withDirectory(directory, asSession('A', options)),
    );
    const waiting = await handleHookEvent(
      inSession('B', dispatch('chef-worker', 'tool-2')),
      withDirectory(directory, asSession('B', options)),
    );
    expect(waiting?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(await places(directory)).toBe(2);
    expect(await workersOf(directory, 'session-B')).toBe(0);
  });

  test('a resumed session is known from its new process, and what the old one held is gone', async () => {
    const directory = await scratch();
    await handleHookEvent(sessionStart('session-A'), context(directory));
    await handleHookEvent(dispatch('chef-worker', 'tool-1'), context(directory));
    expect(await places(directory)).toBe(2);
    await handleHookEvent(sessionStart('session-A'), context(directory));
    expect(await places(directory)).toBe(2);
    // Resumed in a new process: what the old process held ended with it.
    const resumed = hostTable([
      [600, entry(300, claude)],
      [611, entry(600, 'bun host-sessions.ts hook')],
    ]);
    resumed.delete(400);
    resumed.delete(410);
    resumed.delete(411);
    await handleHookEvent(
      sessionStart('session-A'),
      context(directory, { hookPid: 611, readProcessTable: () => resumed }),
    );
    expect(await workersOf(directory, 'session-A')).toBe(0);
    const ledgers = await readSessions(directory);
    const ledger = ledgers.find((each) => each.sessionId === 'session-A');
    expect(ledger?.holder?.pid).toBe(600);
  });

  test('start_session is denied from a leased session and allowed from an unleased one', async () => {
    const directory = await scratch();
    await mkdir(join(directory, 'leases'), { recursive: true });
    await writeFile(
      join(directory, 'leases', 'session-A.json'),
      JSON.stringify({
        sessionId: 'session-A',
        project: 'P',
        run: 'run-1',
        leasedAt: '2026-11-19T00:00:00Z',
        expiresAt: '2999-01-01T00:00:00Z',
      }),
    );
    const denied = await handleHookEvent(startSession('session-A'), context(directory));
    expect(denied?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(denied?.hookSpecificOutput?.permissionDecisionReason).toContain('run-1');
    expect(await handleHookEvent(startSession('session-B'), context(directory))).toBeUndefined();
  });

  test('a lease marker past its expiry is treated as absent', async () => {
    const directory = await scratch();
    await mkdir(join(directory, 'leases'), { recursive: true });
    await writeFile(
      join(directory, 'leases', 'session-A.json'),
      JSON.stringify({
        sessionId: 'session-A',
        project: 'P',
        run: 'run-1',
        leasedAt: '1970-01-01T00:00:00Z',
        // The test clock reads 1,000 seconds past the epoch.
        expiresAt: '1970-01-01T00:00:10Z',
      }),
    );
    expect(await handleHookEvent(startSession('session-A'), context(directory))).toBeUndefined();
  });
});

describe('release', () => {
  const releaseOptions = { readProcessTable: () => hostTable(), ...clock(), pid: 411 };

  test('skips an unrelated live ledger and releases the target in the correct session', async () => {
    const directory = await scratch();
    const options = { ...releaseOptions, cap: 4 };
    await admitWorker({ directory, request: request('A', 'tool-a'), ...options });
    await admitWorker({ directory, request: request('B', 'tool-b'), ...options });

    expect(await releasePlace(directory, 'tool-b', releaseOptions)).toEqual([
      'released tool-b in session session-B: 2 place(s)',
    ]);
    expect(await workersOf(directory, 'session-A')).toBe(1);
    expect(await workersOf(directory, 'session-B')).toBe(0);
  });

  test('frees a pending dispatch, a running agent, or a whole session', async () => {
    const directory = await scratch();
    await handleHookEvent(dispatch('chef-worker', 'tool-1'), context(directory));
    await handleHookEvent(dispatch('chef-worker', 'tool-2'), context(directory));
    await handleHookEvent(agentEvent('SubagentStart', 'agent-1'), context(directory));
    expect(await releasePlace(directory, 'tool-2', releaseOptions)).toEqual([
      'released tool-2 in session session-A: 1 place(s)',
    ]);
    expect(await releasePlace(directory, 'agent-1', releaseOptions)).toEqual([
      'released agent-1 in session session-A: 0 place(s)',
    ]);
    await handleHookEvent(dispatch('chef-worker', 'tool-3'), context(directory));
    expect(await releasePlace(directory, 'session-', releaseOptions)).toEqual([
      'released session session-A: 3 place(s)',
    ]);
    expect(await places(directory)).toBe(0);
    const refusal = await releasePlace(directory, 'nothing-here', releaseOptions).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(refusal).toBe('no session, pending dispatch or running agent is named nothing-here');
  });
});

describe('.claude/settings.json', () => {
  const settings = JSON.parse(
    readFileSync(join(import.meta.dir, '..', '.claude', 'settings.json'), 'utf8'),
  ) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
  };
  const registered = (event: string): Array<Record<string, unknown>> =>
    (settings.hooks[event] ?? []).flatMap((group) =>
      group.hooks
        .filter((hook) => String(hook['command']).includes('scripts/host-sessions.ts hook'))
        .map((hook) => ({ matcher: group.matcher, ...hook })),
    );

  test('the dispatch hook outlasts the wait limit, blocks when it fails, and names the status command while it runs', () => {
    const [hook] = registered('PreToolUse');
    expect(hook).toMatchObject({ matcher: 'Agent', onFailure: 'block' });
    expect(Number(hook?.['timeout']) * 1000).toBeGreaterThan(placeWaitLimitMilliseconds);
    expect(String(hook?.['statusMessage'])).toContain('bun scripts/host-sessions.ts status');
  });

  test('every Agent call, start and stop is registered whatever its type, with no `if` filter', () => {
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied']) {
      const agentHooks = registered(event).filter((hook) => hook['matcher'] === 'Agent');
      expect(agentHooks).toHaveLength(1);
      expect(agentHooks[0]).not.toHaveProperty('if');
    }
    for (const event of ['SubagentStart', 'SubagentStop']) {
      expect(registered(event).map((hook) => hook['matcher'])).toEqual([undefined]);
    }
    // StopFailure matches on the error type, so it runs for every agent and the hook filters.
    expect(registered('StopFailure')).toHaveLength(1);
  });

  test('every session registers at its start, and start_session is checked against its lease', () => {
    expect(registered('SessionStart').map((hook) => hook['matcher'])).toEqual([undefined]);
    expect(registered('PreToolUse').map((hook) => hook['matcher'])).toContain(startSessionToolName);
  });
});
