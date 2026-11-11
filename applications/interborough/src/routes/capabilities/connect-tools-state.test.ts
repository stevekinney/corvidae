/**
 * COR-2022 (board PageConnectTools): the Connect tools page's flow as one state machine. Each
 * transition of `connectTransition` is tested on its own, then `ConnectFlow` is driven with a
 * stand-in test and connect: Connect tests first, a test that passes with Connect pressed goes on to
 * connect, Cancel stops a connect and saves nothing, an answer to a stopped request changes nothing,
 * a connect that runs 15 seconds says so, and a failed connect keeps every choice.
 */
import { afterEach, describe, expect, jest, test } from 'bun:test';

import type { ToolSourceChange, ToolSourceProbe } from '../../lib/host-tool-sources.ts';
import type { ToolChoice } from '../../lib/tool-source-form.ts';
import {
  ConnectFlow,
  connectFooterLine,
  connectTiming,
  connectTransition,
  contactedHost,
  INITIAL_CONNECT_STATE,
  isConnectBusy,
  passedProbeOf,
  sourceAddressOf,
  type ConnectEvent,
  type ConnectPhase,
  type ConnectRequest,
  type ConnectState,
} from './connect-tools-state.svelte.ts';

afterEach(() => {
  jest.useRealTimers();
  connectTiming.slowAfterMilliseconds = 15_000;
});

const SIGNATURE = '{"source":{"id":"github"}}';
const OTHER = '{"source":{"id":"gitlab"}}';

/** GitHub as the sample world has it: two tools that read or change, one dangerous. */
const LISTED: Extract<ToolSourceProbe, { outcome: 'listed' }> = {
  outcome: 'listed',
  tools: [
    { name: 'github__list_issues', tool: 'list_issues', tier: 'read-only', title: 'List issues' },
    { name: 'github__create_issue', tool: 'create_issue', tier: 'mutating', title: 'Create issue' },
    {
      name: 'github__delete_branch',
      tool: 'delete_branch',
      tier: 'dangerous',
      title: 'Delete branch',
    },
  ],
  skipped: [],
};
const NO_ANSWER: ToolSourceProbe = { outcome: 'failed', message: 'The source did not answer.' };
const CHANGE: ToolSourceChange = {
  id: 'github',
  changed: true,
  restartRequired: false,
  available: ['list_issues', 'create_issue'],
};

const state = (phase: ConnectPhase, extra: Partial<ConnectState> = {}): ConnectState => ({
  ...INITIAL_CONNECT_STATE,
  attempt: 1,
  phase,
  ...extra,
});
const step = (from: ConnectState, event: ConnectEvent) => connectTransition(from, event);

const testing = (thenConnect = false): ConnectPhase => ({
  kind: 'testing',
  attempt: 1,
  signature: SIGNATURE,
  thenConnect,
});
const passed: ConnectPhase = { kind: 'passed', signature: SIGNATURE, probe: LISTED };
const failed: ConnectPhase = {
  kind: 'failed',
  signature: SIGNATURE,
  failure: { kind: 'no-answer', message: 'The source did not answer.' },
};
const connecting: ConnectPhase = {
  kind: 'connecting',
  attempt: 1,
  signature: SIGNATURE,
  probe: LISTED,
};
const slow: ConnectPhase = { ...connecting, kind: 'slow' };
const connected: ConnectPhase = {
  kind: 'connected',
  signature: SIGNATURE,
  probe: LISTED,
  change: CHANGE,
};
const failedConnect: ConnectPhase = {
  kind: 'failed-connect',
  signature: SIGNATURE,
  probe: LISTED,
  message: 'The server stopped answering after the test passed.',
};

describe('connectTransition', () => {
  test('idle: Test connection starts a test as a new attempt', () => {
    const next = step(INITIAL_CONNECT_STATE, { type: 'test', signature: SIGNATURE });
    expect(next.attempt).toBe(1);
    expect(next.phase).toEqual({
      kind: 'testing',
      attempt: 1,
      signature: SIGNATURE,
      thenConnect: false,
    });
  });

  test('idle: Connect tests first, and connects once the test passes (row 33n)', () => {
    const next = step(INITIAL_CONNECT_STATE, { type: 'connect', signature: SIGNATURE });
    expect(next.phase).toEqual({
      kind: 'testing',
      attempt: 1,
      signature: SIGNATURE,
      thenConnect: true,
    });
  });

  test('testing: Connect stays enabled and connects after the test (row 34j)', () => {
    const next = step(state(testing()), { type: 'connect', signature: SIGNATURE });
    expect(next.attempt).toBe(1);
    expect(next.phase).toEqual(testing(true));
  });

  test('testing: Test connection again does nothing while one runs', () => {
    const from = state(testing());
    expect(step(from, { type: 'test', signature: SIGNATURE })).toBe(from);
  });

  test('testing: a test that lists tools passes', () => {
    expect(step(state(testing()), { type: 'tested', attempt: 1, probe: LISTED }).phase).toEqual(
      passed,
    );
  });

  test('testing: a test that asks for a sign-in passes too', () => {
    const probe: ToolSourceProbe = { outcome: 'needs-authorization' };
    expect(step(state(testing()), { type: 'tested', attempt: 1, probe }).phase).toEqual({
      kind: 'passed',
      signature: SIGNATURE,
      probe,
    });
  });

  test('testing: a test the source did not answer fails with its words (row 34n)', () => {
    expect(step(state(testing()), { type: 'tested', attempt: 1, probe: NO_ANSWER }).phase).toEqual(
      failed,
    );
  });

  test('testing: a test the host refused fails as refused', () => {
    expect(
      step(state(testing()), { type: 'test-refused', attempt: 1, message: 'Only the owner.' })
        .phase,
    ).toEqual({
      kind: 'failed',
      signature: SIGNATURE,
      failure: { kind: 'refused', message: 'Only the owner.' },
    });
  });

  test('testing with Connect pressed: a test that passes goes on to connect as a new attempt', () => {
    const next = step(state(testing(true)), { type: 'tested', attempt: 1, probe: LISTED });
    expect(next.attempt).toBe(2);
    expect(next.phase).toEqual({ ...connecting, attempt: 2 });
  });

  test('testing with Connect pressed: a test that fails does not connect', () => {
    expect(
      step(state(testing(true)), { type: 'tested', attempt: 1, probe: NO_ANSWER }).phase,
    ).toEqual(failed);
  });

  test('testing: an answer to an earlier attempt changes nothing', () => {
    const from = state(testing(), { attempt: 2 });
    const current = { ...from, phase: { ...testing(), attempt: 2 } };
    expect(step(current, { type: 'tested', attempt: 1, probe: LISTED })).toBe(current);
    expect(step(current, { type: 'test-refused', attempt: 1, message: 'x' })).toBe(current);
  });

  test('testing: Cancel stops the test and leaves no result (row 34s)', () => {
    expect(step(state(testing()), { type: 'cancel' }).phase).toEqual({ kind: 'idle' });
  });

  test('passed: Connect connects as a new attempt', () => {
    const next = step(state(passed), { type: 'connect', signature: SIGNATURE });
    expect(next.attempt).toBe(2);
    expect(next.phase).toEqual({ ...connecting, attempt: 2 });
  });

  test('passed: Connect for a request the test was not made for tests first', () => {
    expect(step(state(passed), { type: 'connect', signature: OTHER }).phase).toMatchObject({
      kind: 'testing',
      signature: OTHER,
      thenConnect: true,
    });
  });

  test('passed: Test connection tests again', () => {
    expect(step(state(passed), { type: 'test', signature: SIGNATURE }).phase).toMatchObject({
      kind: 'testing',
      thenConnect: false,
    });
  });

  test('passed: a change to the form forgets the test, and marks it filled in', () => {
    const next = step(state(passed), { type: 'edit', signature: OTHER, dirty: true });
    expect(next.phase).toEqual({ kind: 'idle' });
    expect(next.dirty).toBe(true);
  });

  test('passed: an edit that leaves the request as it was keeps the test', () => {
    const next = step(state(passed), { type: 'edit', signature: SIGNATURE, dirty: true });
    expect(next.phase).toBe(passed);
  });

  test('failed: Connect tests again first, and Test connection tests again', () => {
    expect(step(state(failed), { type: 'connect', signature: SIGNATURE }).phase).toMatchObject({
      kind: 'testing',
      thenConnect: true,
    });
    expect(step(state(failed), { type: 'test', signature: SIGNATURE }).phase).toMatchObject({
      kind: 'testing',
      thenConnect: false,
    });
  });

  test('failed: a change to the form forgets the failure', () => {
    expect(step(state(failed), { type: 'edit', signature: OTHER, dirty: true }).phase).toEqual({
      kind: 'idle',
    });
  });

  test('connecting: 15 seconds in, it is slow (row 34z)', () => {
    expect(step(state(connecting), { type: 'slow', attempt: 1 }).phase).toEqual(slow);
  });

  test('connecting: a slow mark for an earlier attempt changes nothing', () => {
    const from = state(connecting);
    expect(step(from, { type: 'slow', attempt: 0 })).toBe(from);
  });

  test('connecting: a saved source is connected, and the form has nothing left to lose', () => {
    const next = step(state(connecting, { dirty: true }), {
      type: 'connected',
      attempt: 1,
      change: CHANGE,
    });
    expect(next.phase).toEqual(connected);
    expect(next.dirty).toBe(false);
  });

  test('slow: a saved source is connected too', () => {
    expect(step(state(slow), { type: 'connected', attempt: 1, change: CHANGE }).phase).toEqual(
      connected,
    );
  });

  test('connecting: a connect that fails keeps the test and says why (row 34b)', () => {
    expect(
      step(state(connecting), {
        type: 'connect-refused',
        attempt: 1,
        message: 'The server stopped answering after the test passed.',
      }).phase,
    ).toEqual(failedConnect);
  });

  test('connecting: a refusal put under a field goes back to the test that passed', () => {
    expect(
      step(state(connecting), { type: 'connect-refused', attempt: 1, message: '' }).phase,
    ).toEqual(passed);
  });

  test('connecting and slow: Cancel stops the connect and goes back to the passed test (rows 34a, 34z)', () => {
    expect(step(state(connecting), { type: 'cancel' }).phase).toEqual(passed);
    expect(step(state(slow), { type: 'cancel' }).phase).toEqual(passed);
  });

  test('connecting: an answer to a stopped connect changes nothing', () => {
    const from = state(passed, { attempt: 1 });
    expect(step(from, { type: 'connected', attempt: 1, change: CHANGE })).toBe(from);
    expect(step(from, { type: 'connect-refused', attempt: 1, message: 'x' })).toBe(from);
  });

  test('connecting: Test connection and Connect do nothing while it runs', () => {
    const from = state(connecting);
    expect(step(from, { type: 'test', signature: SIGNATURE })).toBe(from);
    expect(step(from, { type: 'connect', signature: SIGNATURE })).toBe(from);
  });

  test('failed-connect: Try again connects again with the test that passed (row 34b)', () => {
    const next = step(state(failedConnect), { type: 'connect', signature: SIGNATURE });
    expect(next.phase).toEqual({ ...connecting, attempt: 2 });
  });

  test('failed-connect: a change to the form forgets it', () => {
    expect(
      step(state(failedConnect), { type: 'edit', signature: OTHER, dirty: true }).phase,
    ).toEqual({ kind: 'idle' });
  });

  test('connected: nothing more happens, and Cancel changes nothing', () => {
    const from = state(connected);
    expect(step(from, { type: 'test', signature: SIGNATURE })).toBe(from);
    expect(step(from, { type: 'connect', signature: SIGNATURE })).toBe(from);
    expect(step(from, { type: 'cancel' })).toBe(from);
    expect(step(from, { type: 'edit', signature: OTHER, dirty: true }).phase).toBe(connected);
  });

  test('idle: an untouched form is not dirty, and a filled one is (row 35b)', () => {
    expect(step(INITIAL_CONNECT_STATE, { type: 'edit', signature: '', dirty: false }).dirty).toBe(
      false,
    );
    expect(
      step(INITIAL_CONNECT_STATE, { type: 'edit', signature: SIGNATURE, dirty: true }).dirty,
    ).toBe(true);
  });

  test('offline: Test connection and Connect do nothing, and the form stays as typed (row 35f)', () => {
    const offline = step(state(passed, { dirty: true }), { type: 'connection', offline: true });
    expect(offline.offline).toBe(true);
    expect(offline.phase).toBe(passed);
    expect(step(offline, { type: 'test', signature: SIGNATURE })).toBe(offline);
    expect(step(offline, { type: 'connect', signature: SIGNATURE })).toBe(offline);
    expect(offline.dirty).toBe(true);
    const back = step(offline, { type: 'connection', offline: false });
    expect(back.offline).toBe(false);
    expect(step(back, { type: 'connect', signature: SIGNATURE }).phase.kind).toBe('connecting');
  });
});

describe('what the phases say', () => {
  const context = {
    listed: false,
    chosen: 0,
    transport: 'http',
    kind: 'mcp',
    duplicate: false,
  } as const;

  test('the footer says to test to choose tools before a test passes (row 33n)', () => {
    expect(connectFooterLine(INITIAL_CONNECT_STATE, context)).toEqual({ kind: 'choose-first' });
  });

  test('a local command, a test in flight, and an address already connected say Connect tests first (rows 33r, 34j, 34e)', () => {
    expect(connectFooterLine(INITIAL_CONNECT_STATE, { ...context, transport: 'stdio' })).toEqual({
      kind: 'tests-first',
    });
    expect(connectFooterLine(state(testing()), context)).toEqual({ kind: 'tests-first' });
    expect(connectFooterLine(INITIAL_CONNECT_STATE, { ...context, duplicate: true })).toEqual({
      kind: 'tests-first',
    });
  });

  test('once tools are listed it counts the ones that join, also after a failed connect and with none (rows 34c, 34x)', () => {
    expect(connectFooterLine(state(passed), { ...context, listed: true, chosen: 2 })).toEqual({
      kind: 'joins',
      count: 2,
    });
    expect(
      connectFooterLine(state(failedConnect), { ...context, listed: true, chosen: 2 }),
    ).toEqual({ kind: 'joins', count: 2 });
    expect(connectFooterLine(state(passed), { ...context, listed: true, chosen: 0 })).toEqual({
      kind: 'joins',
      count: 0,
    });
  });

  test('while connecting it says so, and adds that it is slow after 15 s (row 34z)', () => {
    expect(connectFooterLine(state(connecting), context)).toEqual({
      kind: 'connecting',
      slow: false,
    });
    expect(connectFooterLine(state(slow), context)).toEqual({ kind: 'connecting', slow: true });
  });

  test('while the server does not answer it says Connect is off (row 35f)', () => {
    expect(
      connectFooterLine(state(passed, { offline: true }), { ...context, listed: true }),
    ).toEqual({ kind: 'offline' });
  });

  test('a request is in flight while testing or connecting, and a passed test is kept until it is forgotten', () => {
    expect([testing(), connecting, slow].every(isConnectBusy)).toBe(true);
    expect([passed, failed, connected, failedConnect].some(isConnectBusy)).toBe(false);
    expect(passedProbeOf(passed)).toBe(LISTED);
    expect(passedProbeOf(failedConnect)).toBe(LISTED);
    expect(passedProbeOf(failed)).toBeUndefined();
    expect(passedProbeOf({ kind: 'idle' })).toBeUndefined();
  });

  test('an address is known by its origin and path, as the host cuts it', () => {
    expect(sourceAddressOf(' https://mcp.github.example/mcp?token=x#y ')).toBe(
      'https://mcp.github.example/mcp',
    );
    expect(sourceAddressOf('not an address')).toBeUndefined();
    expect(contactedHost('https://mcp.github.example/mcp')).toBe('mcp.github.example');
    expect(contactedHost('')).toBeUndefined();
  });
});

describe('ConnectFlow', () => {
  type Seen = { readonly probes: AbortSignal[]; readonly connects: AbortSignal[] };

  /** A request whose test and connect answer with the promises given, and records each call. */
  function request(
    answers: {
      readonly probe?: () => Promise<ToolSourceProbe>;
      readonly connect?: (
        choices: Readonly<Record<string, ToolChoice>>,
      ) => Promise<ToolSourceChange>;
    },
    seen: Seen = { probes: [], connects: [] },
  ): { readonly request: ConnectRequest; readonly seen: Seen } {
    return {
      seen,
      request: {
        signature: SIGNATURE,
        kind: 'mcp',
        probe: (signal) => {
          seen.probes.push(signal);
          return answers.probe?.() ?? Promise.resolve(LISTED);
        },
        connect: (choices, signal) => {
          seen.connects.push(signal);
          return answers.connect?.(choices) ?? Promise.resolve(CHANGE);
        },
      },
    };
  }

  test('Connect before a test: tests, seeds Choose tools from what it lists, then connects with them', async () => {
    const flow = new ConnectFlow(() => '');
    const probe = Promise.withResolvers<ToolSourceProbe>();
    const saved = Promise.withResolvers<ToolSourceChange>();
    const sent: Readonly<Record<string, ToolChoice>>[] = [];
    const { request: ready, seen } = request({
      probe: () => probe.promise,
      connect: (choices) => {
        sent.push(choices);
        return saved.promise;
      },
    });

    flow.connect(ready);
    expect(flow.phase.kind).toBe('testing');
    probe.resolve(LISTED);
    await probe.promise;

    expect(flow.phase.kind).toBe('connecting');
    expect(seen.connects).toHaveLength(1);
    // An MCP server's tools all start on; a dangerous one starts on Always (row 33i).
    expect(sent[0]).toEqual({
      list_issues: { on: true, approval: 'never' },
      create_issue: { on: true, approval: 'on-changes' },
      delete_branch: { on: true, approval: 'always' },
    });
    saved.resolve(CHANGE);
    await saved.promise;
    expect(flow.phase).toEqual(connected);
    expect(flow.state.dirty).toBe(false);
  });

  test('Cancel during a connect aborts it, saves nothing, keeps the choices, and ignores its late answer (rows 34a, 34z)', async () => {
    const flow = new ConnectFlow(() => '');
    const saved = Promise.withResolvers<ToolSourceChange>();
    const { request: ready, seen } = request({ connect: () => saved.promise });
    flow.test(ready);
    await seenProbe(flow);
    flow.choose('delete_branch', { on: false });

    flow.connect(ready);
    expect(flow.phase.kind).toBe('connecting');
    expect(flow.cancel()).toBe(true);

    expect(seen.connects[0]?.aborted).toBe(true);
    expect(flow.phase).toEqual(passed);
    expect(flow.choices['delete_branch']).toEqual({ on: false, approval: 'always' });
    saved.resolve(CHANGE);
    await saved.promise;
    expect(flow.phase).toEqual(passed);
  });

  test('Cancel with nothing in flight answers that there was nothing to stop', () => {
    const flow = new ConnectFlow(() => '');
    expect(flow.cancel()).toBe(false);
    expect(flow.phase).toEqual({ kind: 'idle' });
  });

  test('a connect that runs 15 seconds says it is taking longer than usual (row 34z)', async () => {
    jest.useFakeTimers();
    const flow = new ConnectFlow(() => '');
    const saved = Promise.withResolvers<ToolSourceChange>();
    const { request: ready } = request({ connect: () => saved.promise });
    flow.test(ready);
    await seenProbe(flow);

    flow.connect(ready);
    jest.advanceTimersByTime(connectTiming.slowAfterMilliseconds);

    expect(flow.phase.kind).toBe('slow');
    saved.resolve(CHANGE);
    await saved.promise;
    expect(flow.phase.kind).toBe('connected');
  });

  test('a connect that fails keeps every choice, and Try again sends them as they were (rows 34b, 34c)', async () => {
    const flow = new ConnectFlow((_, stage) =>
      stage === 'connect' ? 'It stopped answering.' : '',
    );
    const sent: Readonly<Record<string, ToolChoice>>[] = [];
    let fail = true;
    const { request: ready } = request({
      connect: async (choices) => {
        sent.push(choices);
        if (fail) throw new TypeError('Failed to fetch');
        return CHANGE;
      },
    });
    flow.test(ready);
    await seenProbe(flow);
    flow.choose('delete_branch', { on: false });

    flow.connect(ready);
    await until(() => flow.phase.kind === 'failed-connect');
    expect(flow.phase).toMatchObject({ kind: 'failed-connect', message: 'It stopped answering.' });
    expect(flow.choices['delete_branch']?.on).toBe(false);

    // The same tools listed again keep the choices made.
    flow.seed('mcp', LISTED.tools);
    expect(flow.choices['delete_branch']?.on).toBe(false);

    fail = false;
    flow.connect(ready);
    await until(() => flow.phase.kind === 'connected');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });

  test('a test the host refuses is described for the whole request', async () => {
    const flow = new ConnectFlow((error, stage) =>
      stage === 'test' && error instanceof Error ? error.message : '',
    );
    const { request: ready } = request({
      probe: () => Promise.reject(new Error('Only the owner may.')),
    });

    flow.test(ready);
    await until(() => flow.phase.kind === 'failed');

    expect(flow.phase).toMatchObject({
      kind: 'failed',
      failure: { kind: 'refused', message: 'Only the owner may.' },
    });
  });

  test('Select all turns every listed tool on or off, and a tool not listed is left alone', async () => {
    const flow = new ConnectFlow(() => '');
    flow.seed('openapi', [
      { tool: 'listRefunds', tier: 'read-only' },
      { tool: 'createRefund', tier: 'mutating' },
    ]);
    // An OpenAPI spec's reads start on and its changes start off (row 33w).
    expect(flow.choices).toEqual({
      listRefunds: { on: true, approval: 'never' },
      createRefund: { on: false, approval: 'on-changes' },
    });

    flow.chooseAll(['listRefunds', 'createRefund', 'missing'], true);

    expect(Object.values(flow.choices).every((choice) => choice.on)).toBe(true);
    expect(Object.hasOwn(flow.choices, 'missing')).toBe(false);
  });

  /** Waits for a test that lists the tools to have passed. Only microtasks are pending. */
  async function seenProbe(flow: ConnectFlow): Promise<void> {
    await until(() => flow.phase.kind === 'passed');
  }

  /**
   * Drains microtasks until `condition` holds: the stand-in answers are settled promises, so only
   * microtasks are pending, and their count belongs to the code. A flow that never gets there
   * fails here instead of spinning, which would starve the hang guard's own timer.
   */
  async function until(condition: () => boolean): Promise<void> {
    for (let drained = 0; drained < 1_000; drained += 1) {
      if (condition()) return;
      await Promise.resolve();
    }
    throw new Error('The flow did not get there once its answers had settled.');
  }
});
