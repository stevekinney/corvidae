import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
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
  placeTakingAgentTypes,
  placeWaitLimitMilliseconds,
  readSessions,
  releasePlace,
  sessionProcess,
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

async function workersOf(directory: string, sessionId: string): Promise<number> {
  const ledger = (await readSessions(directory)).find((each) => each.sessionId === sessionId);
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
    expect((await readSessions(directory)).map((ledger) => ledger.sessionId)).toEqual([
      'session-A',
    ]);
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
    expect((await readSessions(directory)).map((ledger) => ledger.sessionId)).toEqual([
      'session-B',
    ]);
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
    // One worker of A runs: A holds 2, B takes 2, past the cap of 3, so B still waits; but the
    // stale admission is gone.
    expect(admission.admitted).toBe(false);
    expect(await workersOf(directory, 'session-A')).toBe(1);
    expect(await places(directory)).toBe(2);
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
});

describe('the hook', () => {
  test('read-only agent types take no place', async () => {
    const directory = await scratch();
    for (const type of ['chef-reviewer', 'design-reviewer', 'Explore', 'scout', '']) {
      expect(
        await handleHookEvent(dispatch(type, `t-${type}`), context(directory)),
      ).toBeUndefined();
    }
    expect(await readSessions(directory)).toEqual([]);
  });

  test('takes places on dispatch, keeps them through the start, and returns them when the worker stops', async () => {
    const directory = await scratch();
    expect(
      await handleHookEvent(dispatch('chef-worker', 'tool-1'), context(directory)),
    ).toBeUndefined();
    expect(await places(directory)).toBe(2);
    await handleHookEvent(agentEvent('SubagentStart', 'agent-1'), context(directory));
    expect(await places(directory)).toBe(2);
    // A stop of a read-only type, or of an agent never started here, returns nothing.
    await handleHookEvent(agentEvent('SubagentStop', 'agent-1', 'Explore'), context(directory));
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

describe('release', () => {
  const releaseOptions = { readProcessTable: () => hostTable(), ...clock(), pid: 411 };

  test('frees a pending dispatch, a running agent, or a whole session', async () => {
    const directory = await scratch();
    await handleHookEvent(dispatch('chef-worker', 'tool-1'), context(directory));
    await handleHookEvent(dispatch('chef-worker', 'tool-2'), context(directory));
    await handleHookEvent(agentEvent('SubagentStart', 'agent-1'), context(directory));
    expect(await releasePlace(directory, 'tool-2', releaseOptions)).toEqual([
      'released tool-2 in session session-A: 1 place(s)',
    ]);
    expect(await releasePlace(directory, 'agent-1', releaseOptions)).toEqual([
      'released agent-1 in session session-A: 2 place(s)',
    ]);
    await handleHookEvent(dispatch('chef-worker', 'tool-3'), context(directory));
    expect(await releasePlace(directory, 'session-', releaseOptions)).toEqual([
      'released session session-A: 2 place(s)',
    ]);
    expect(await places(directory)).toBe(0);
    await expect(releasePlace(directory, 'nothing-here', releaseOptions)).rejects.toThrow(
      'no session, pending dispatch or running agent is named nothing-here',
    );
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

  test('every place-taking type is registered for dispatch, start, stop, result and denial', () => {
    const types = [...placeTakingAgentTypes];
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied']) {
      expect(registered(event).map((hook) => hook['if'])).toEqual(
        types.map((type) => `Agent(${type})`),
      );
    }
    for (const event of ['SubagentStart', 'SubagentStop']) {
      expect(registered(event).map((hook) => hook['matcher'])).toEqual([types.join('|')]);
    }
    // StopFailure matches on the error type, so it runs for every agent and the hook filters.
    expect(registered('StopFailure')).toHaveLength(1);
  });
});
