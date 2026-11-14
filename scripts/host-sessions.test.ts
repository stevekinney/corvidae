import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProcessEntry, ProcessTable } from './bun-test-pool.ts';
import {
  admitWorker,
  capBypassVariable,
  handleHookEvent,
  hostPlaceCap,
  placePollIntervalMilliseconds,
  placeTakingAgentTypes,
  placeWaitLimitMilliseconds,
  readPlaces,
  sessionProcess,
  type HookContext,
  type HookInput,
  type PlaceRecord,
  type PlaceRequest,
} from './host-sessions.ts';
import { tryInstall } from './run-exclusively.ts';

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

function clock() {
  const state = { now: 1_000_000, sleeps: 0 };
  return {
    state,
    now: () => state.now,
    sleep: async (milliseconds: number) => {
      state.sleeps += 1;
      state.now += milliseconds;
    },
  };
}

async function recordsIn(directory: string): Promise<PlaceRecord[]> {
  const places = await readPlaces(directory);
  return places.map((place) => place.record);
}

async function placeKinds(directory: string): Promise<string[]> {
  const records = await recordsIn(directory);
  return records.map((record) => `${record.kind}:${record.sessionId}`);
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
  test('admits at once while places are free, with a place for the coordinator the first time', async () => {
    const directory = await scratch();
    const time = clock();
    const options = { directory, readProcessTable: () => hostTable(), ...time };
    const first = await admitWorker({ ...options, request: request('A', '1') });
    expect(first).toEqual({ admitted: true, bypassed: false, waitedMilliseconds: 0 });
    expect(await placeKinds(directory)).toEqual(['worker:session-A', 'coordinator:session-A']);
    const second = await admitWorker({ ...options, request: request('A', '2') });
    expect(second.admitted).toBe(true);
    expect(await placeKinds(directory)).toEqual([
      'worker:session-A',
      'coordinator:session-A',
      'worker:session-A',
    ]);
    expect(time.state.sleeps).toBe(0);
    expect(await readdir(join(directory, 'queue'))).toEqual([]);
  });

  test('waits, then admits once a holder releases, reporting who held the places', async () => {
    const directory = await scratch();
    const time = clock();
    const options = { directory, readProcessTable: () => hostTable(), ...time };
    await admitWorker({ ...options, request: request('A', '1') });
    let released = false;
    const admission = await admitWorker({
      ...options,
      request: request('B', '2'),
      // Session B needs a worker's place and a coordinator's: 2 + 2 is over the cap until A's
      // worker ends, which leaves A's coordinator place with no worker.
      sleep: async (milliseconds) => {
        await time.sleep(milliseconds);
        if (!released) {
          released = true;
          await handleHookEvent(
            {
              hook_event_name: 'PostToolUseFailure',
              session_id: 'session-A',
              tool_name: 'Agent',
              tool_use_id: '1',
              tool_input: { subagent_type: 'chef-worker' },
            },
            context(directory),
          );
        }
      },
    });
    expect(admission.admitted).toBe(true);
    if (!admission.admitted) throw new Error('unreachable');
    expect(admission.waitedMilliseconds).toBe(placePollIntervalMilliseconds);
    expect(admission.heldWhenWaiting?.[0]).toBe(`2 of ${hostPlaceCap} host places held`);
    expect(admission.heldWhenWaiting?.join('\n')).toContain('worker COR-1 "Deliver COR-1"');
    expect(await placeKinds(directory)).toEqual(['worker:session-B', 'coordinator:session-B']);
  });

  test('waits up to the limit, then refuses with the holders and leaves no ticket', async () => {
    const directory = await scratch();
    const time = clock();
    const options = { directory, readProcessTable: () => hostTable(), ...time };
    await admitWorker({ ...options, request: request('A', '1') });
    await admitWorker({ ...options, request: request('A', '2') });
    const admission = await admitWorker({ ...options, request: request('B', '3') });
    expect(admission.admitted).toBe(false);
    if (admission.admitted) throw new Error('unreachable');
    expect(admission.waitedMilliseconds).toBe(placeWaitLimitMilliseconds);
    expect(time.state.sleeps).toBe(placeWaitLimitMilliseconds / placePollIntervalMilliseconds);
    expect(admission.held[0]).toBe('3 of 3 host places held');
    expect(admission.held.slice(1).join('\n')).toContain(
      'coordinator (session session-, main agent)',
    );
    expect(await placeKinds(directory)).toHaveLength(3);
    expect(await readdir(join(directory, 'queue'))).toEqual([]);
  });

  test('reclaims a place whose session process is gone on the next acquire', async () => {
    const directory = await scratch();
    const time = clock();
    await admitWorker({
      directory,
      readProcessTable: () => hostTable(),
      ...time,
      request: request('A', '1', { holder: { pid: 999_999, pidStartedAt: 'gone' } }),
    });
    await admitWorker({
      directory,
      readProcessTable: () => hostTable(),
      ...time,
      request: request('A', '2'),
    });
    expect(await placeKinds(directory)).toEqual(['worker:session-A', 'coordinator:session-A']);
    const reclaimed = await recordsIn(directory);
    expect(reclaimed.every((record) => record.pid === 400)).toBe(true);
    // A recycled pid is not the holder: the start time decides.
    const recycled = hostTable([[400, { ...entry(300, claude), startedAt: 'a later start' }]]);
    const admission = await admitWorker({
      directory,
      readProcessTable: () => recycled,
      ...time,
      cap: 2,
      request: request('B', '3', {
        holder: { pid: 500, pidStartedAt: recycled.get(500)?.startedAt ?? '' },
      }),
    });
    expect(admission.admitted).toBe(true);
    expect(await placeKinds(directory)).toEqual(['worker:session-B', 'coordinator:session-B']);
  });

  test('skips a dead waiter ahead in the queue', async () => {
    const directory = await scratch();
    const time = clock();
    const queue = join(directory, 'queue');
    await mkdir(queue, { recursive: true });
    await Bun.write(
      join(queue, '0000000000000001-dead.json'),
      JSON.stringify({
        pid: 999_998,
        command: 'dead waiter',
        cwd: '/',
        acquiredAt: '',
        token: 'dead',
      }),
    );
    const admission = await admitWorker({
      directory,
      readProcessTable: () => hostTable(),
      ...time,
      request: request('A', '1'),
    });
    expect(admission.admitted).toBe(true);
    expect(time.state.sleeps).toBe(0);
    expect(await readdir(queue)).toEqual([]);
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
    expect(await readPlaces(directory)).toEqual([]);
  });

  test('takes a place on dispatch, binds it at the start, and releases it when the worker stops', async () => {
    const directory = await scratch();
    expect(
      await handleHookEvent(dispatch('chef-worker', 'tool-1'), context(directory)),
    ).toBeUndefined();
    const [worker] = await readPlaces(directory);
    expect(worker?.record).toMatchObject({ pid: 400, issue: 'COR-1', toolUseId: 'tool-1' });
    await handleHookEvent(
      {
        hook_event_name: 'SubagentStart',
        session_id: 'session-A',
        agent_id: 'agent-1',
        agent_type: 'chef-worker',
      },
      context(directory),
    );
    const [bound] = await recordsIn(directory);
    expect(bound?.agentId).toBe('agent-1');
    // A second stop of the same agent, or one of a read-only type, releases nothing more.
    await handleHookEvent(
      {
        hook_event_name: 'SubagentStop',
        session_id: 'session-A',
        agent_id: 'agent-1',
        agent_type: 'Explore',
      },
      context(directory),
    );
    expect(await readPlaces(directory)).toHaveLength(2);
    await handleHookEvent(
      {
        hook_event_name: 'SubagentStop',
        session_id: 'session-A',
        agent_id: 'agent-1',
        agent_type: 'chef-worker',
      },
      context(directory),
    );
    expect(await placeKinds(directory)).toEqual(['coordinator:session-A']);
  });

  test('binds a backgrounded worker from PostToolUse and releases a foreground one when it completes', async () => {
    const directory = await scratch();
    await handleHookEvent(dispatch('chef-worker', 'tool-1'), context(directory));
    await handleHookEvent(dispatch('chef-worker', 'tool-2'), context(directory));
    const after = (toolUseId: string, status: string, agentId: string): HookInput => ({
      hook_event_name: 'PostToolUse',
      session_id: 'session-A',
      tool_name: 'Agent',
      tool_use_id: toolUseId,
      tool_input: { subagent_type: 'chef-worker' },
      tool_response: { status, agentId },
    });
    await handleHookEvent(after('tool-1', 'async_launched', 'agent-1'), context(directory));
    const launched = await recordsIn(directory);
    expect(launched.find((record) => record.toolUseId === 'tool-1')?.agentId).toBe('agent-1');
    await handleHookEvent(after('tool-2', 'completed', 'agent-2'), context(directory));
    const left = await recordsIn(directory);
    expect(left.map((record) => record.toolUseId ?? 'coordinator')).toEqual([
      'tool-1',
      'coordinator',
    ]);
  });

  test('denies at the cap after the wait, naming the holders, the status command and the bypass', async () => {
    const directory = await scratch();
    await handleHookEvent(dispatch('chef-worker', 'tool-1'), context(directory));
    await handleHookEvent(dispatch('chef-worker', 'tool-2'), context(directory));
    const output = await handleHookEvent(
      { ...dispatch('chef-worker', 'tool-3', 'Deliver COR-3'), session_id: 'session-B' },
      context(directory, { hookPid: 511 }),
    );
    expect(output?.hookSpecificOutput?.permissionDecision).toBe('deny');
    const reason = output?.hookSpecificOutput?.permissionDecisionReason ?? '';
    expect(reason).toContain('waited 20 minute(s)');
    expect(reason).toContain('3 of 3 host places held');
    expect(reason).toContain('worker COR-1 "Deliver COR-1"');
    expect(reason).toContain('Retry the dispatch later');
    expect(reason).toContain('bun scripts/host-sessions.ts status');
    expect(reason).toContain(capBypassVariable);
    expect(await readPlaces(directory)).toHaveLength(3);
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
    const places = await readPlaces(directory);
    expect(places).toHaveLength(4);
    expect(places.find((place) => place.record.bypass === true)?.directory).toContain('bypass-');
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
    expect(await readPlaces(directory)).toEqual([]);
  });

  test('a place installed by another run is never taken twice', async () => {
    const directory = await scratch();
    await mkdir(directory, { recursive: true });
    const record = { pid: 500, command: 'x', cwd: '/', acquiredAt: '', token: 'held' };
    expect(await tryInstall(join(directory, 'place-0'), record)).toBe(true);
    expect(await tryInstall(join(directory, 'place-0'), { ...record, token: 'other' })).toBe(false);
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

  test('the dispatch hook outlasts the wait limit and blocks when it fails', () => {
    const [hook] = registered('PreToolUse');
    expect(hook).toMatchObject({ matcher: 'Agent', onFailure: 'block' });
    expect(Number(hook?.['timeout']) * 1000).toBeGreaterThan(placeWaitLimitMilliseconds);
  });

  test('every place-taking type is registered for dispatch, start, stop and result', () => {
    const types = [...placeTakingAgentTypes];
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
      expect(registered(event).map((hook) => hook['if'])).toEqual(
        types.map((type) => `Agent(${type})`),
      );
    }
    for (const event of ['SubagentStart', 'SubagentStop']) {
      expect(registered(event).map((hook) => hook['matcher'])).toEqual([types.join('|')]);
    }
  });
});
