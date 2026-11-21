import { describe, expect, test } from 'bun:test';

import {
  dispatchKinds,
  exploreInterleavings,
  kindSequences,
  reclaimKinds,
  type ApplyEvent,
} from './host-sessions-interleavings.ts';
import {
  applySessionEvent,
  emptySession,
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

const admit = (toolUseId: string, at = 0): Extract<SessionEvent, { kind: 'admit' }> => ({
  kind: 'admit',
  toolUseId,
  at,
  description: `Deliver ${toolUseId}`,
  dispatcher: '',
});
const start = (agentId: string, at = 0): Extract<SessionEvent, { kind: 'start' }> => ({
  kind: 'start',
  agentId,
  at,
});
const stop = (agentId: string, at = 0): SessionEvent => ({ kind: 'stop', agentId, at });
const launched = (toolUseId: string, agentId: string): SessionEvent => ({
  kind: 'launched',
  toolUseId,
  agentId,
  at: 0,
});
const completed = (toolUseId: string, agentId: string): SessionEvent => ({
  kind: 'completed',
  toolUseId,
  agentId,
  at: 0,
});
const failed = (toolUseId: string): SessionEvent => ({ kind: 'failed', toolUseId, at: 0 });

/** The worker places after each prefix of `events`. */
function placesAfterEach(events: readonly SessionEvent[]): number[] {
  const counts: number[] = [];
  let state: SessionState = emptySession;
  for (const event of events) {
    state = applySessionEvent(state, event);
    counts.push(workerPlaces(state));
  }
  return counts;
}

describe('the session count', () => {
  test('two background workers whose second starts first: the first still holds a place after the second stops', () => {
    // Pre(tA), Pre(tB), Start(b), Post(tB, async_launched), Start(a), Stop(b): the order that bound
    // b to both places and freed both on Stop(b).
    const events = [
      admit('tA'),
      admit('tB'),
      start('b'),
      launched('tB', 'b'),
      start('a'),
      stop('b'),
    ];
    expect(placesAfterEach(events)).toEqual([1, 2, 2, 2, 2, 1]);
    const state = foldSession(events);
    expect(sessionPlaces(state)).toBe(2);
    expect(state.dispatches.get('tA')).toMatchObject({ status: 'started', agentId: 'a' });
    expect(state.dispatches.get('tB')).toMatchObject({
      status: 'started',
      agentId: 'b',
      linked: true,
    });
  });

  test('two background workers launched in order: the second still holds a place after the first stops', () => {
    // Pre(tA), Pre(tB), Post(tA), Start(a), Post(tB), Start(b), Stop(a).
    const events = [
      admit('tA'),
      admit('tB'),
      launched('tA', 'a'),
      start('a'),
      launched('tB', 'b'),
      start('b'),
      stop('a'),
    ];
    expect(placesAfterEach(events)).toEqual([1, 2, 2, 2, 2, 2, 1]);
    expect(sessionPlaces(foldSession(events))).toBe(2);
  });

  test('a dispatch reclaimed as never started that then starts takes a place, which its stop returns', () => {
    const late = neverStartedLimitMilliseconds;
    const events: SessionEvent[] = [
      admit('tA', 0),
      { kind: 'expire', toolUseId: 'tA', at: late },
      { kind: 'start', agentId: 'a', at: late + 1, overCap: true },
      admit('tB', late + 2),
      stop('a', late + 3),
    ];
    expect(placesAfterEach(events)).toEqual([1, 0, 1, 2, 1]);
    const running = foldSession(events.slice(0, 3)).agents.get('a');
    expect(running?.overCap).toBe(true);
    expect(running !== undefined && runsWithoutAdmission(running)).toBe(true);
  });

  test('an agent resumed by SendMessage after its stop takes a place again, and a repeated stop returns none', () => {
    const events = [admit('tA'), start('a'), stop('a'), start('a'), stop('a'), stop('a')];
    expect(placesAfterEach(events)).toEqual([1, 1, 0, 1, 0, 0]);
    const resumed = foldSession(events.slice(0, 4)).agents.get('a');
    expect(resumed?.runs).toBe(2);
    expect(resumed !== undefined && runsWithoutAdmission(resumed)).toBe(true);
  });

  test('a start for a running agent, a stop for an agent never started, and a repeated admission change nothing', () => {
    const events = [admit('tA'), start('a'), start('a'), stop('x'), admit('tA')];
    expect(placesAfterEach(events)).toEqual([1, 1, 1, 1, 1]);
  });

  test('a completed foreground call returns its place once, whether or not its stop fired', () => {
    expect(placesAfterEach([admit('tA'), start('a'), stop('a'), completed('tA', 'a')])).toEqual([
      1, 1, 0, 0,
    ]);
    expect(placesAfterEach([admit('tA'), start('a'), completed('tA', 'a'), stop('a')])).toEqual([
      1, 1, 0, 0,
    ]);
    // No agent ever started: the call's result returns the admission's place.
    expect(placesAfterEach([admit('tA'), completed('tA', '')])).toEqual([1, 0]);
  });

  test('a failure before the start returns the place once, and gives back a place start order guessed', () => {
    expect(placesAfterEach([admit('tA'), failed('tA'), failed('tA')])).toEqual([1, 0, 0]);
    // b is tB's agent, but start order gave it tA's place; tA's failure moves b to tB.
    const events = [admit('tA'), admit('tB'), start('b'), failed('tA'), stop('b')];
    expect(placesAfterEach(events)).toEqual([1, 2, 2, 1, 0]);
    expect(foldSession(events).dispatches.get('tB')?.agentId).toBe('b');
  });

  test('a release frees each place it can identify while an anonymous start keeps its other compatible dispatch reserved', () => {
    const events: SessionEvent[] = [
      admit('tA'),
      admit('tB'),
      start('a'),
      { kind: 'release', target: 'tB', at: 0 },
      { kind: 'release', target: 'a', at: 0 },
    ];
    expect(placesAfterEach(events)).toEqual([1, 2, 2, 1, 1]);
  });

  test('a launched dispatch whose start was never recorded keeps its place past the limit, and its stop returns it', () => {
    const events = [admit('tA', 0), launched('tA', 'a')];
    const state = foldSession(events);
    expect(neverStarted(state, neverStartedLimitMilliseconds * 3)).toEqual([]);
    expect(workerPlaces(state)).toBe(1);
    expect(placesAfterEach([...events, stop('a'), stop('a')])).toEqual([1, 1, 0, 0]);
  });

  test('an ambiguous start prevents either compatible dispatch from expiring', () => {
    const state = foldSession([admit('tA', 0), admit('tB', 5), start('a', 6)]);
    expect(neverStarted(state, neverStartedLimitMilliseconds + 4).map((d) => d.toolUseId)).toEqual(
      [],
    );
    expect(neverStarted(state, neverStartedLimitMilliseconds + 5)).toEqual([]);
  });

  test('a late anonymous start holds the maximum compatible count until either dispatch link resolves it', () => {
    const prefix: SessionEvent[] = [
      admit('t0'),
      { kind: 'expire', toolUseId: 't0', at: 1 },
      admit('t1'),
      start('a0', 2),
    ];
    expect(placesAfterEach(prefix)).toEqual([1, 0, 1, 2]);
    expect(placesAfterEach([...prefix, launched('t0', 'a0')])).toEqual([1, 0, 1, 2, 2]);
    expect(placesAfterEach([...prefix, launched('t1', 'a0')])).toEqual([1, 0, 1, 2, 1]);
  });

  test('projects every capacity rate independently across compatible histories', () => {
    const workerAndReadOnly = foldSession([
      {
        ...admit('t-read-only'),
        agentType: 'Explore',
        readOnly: true,
      },
      admit('t-worker'),
      start('a'),
      stop('a'),
    ]);
    expect([workerPlaces(workerAndReadOnly), readOnlyAgents(workerAndReadOnly)]).toEqual([1, 1]);

    const workerAndOpus = foldSession([
      { ...admit('t-opus'), agentType: 'chef-reviewer', opus: true },
      { ...admit('t-worker'), agentType: 'chef-worker' },
      start('a'),
      stop('a'),
    ]);
    expect([workerPlaces(workerAndOpus), opusPlaces(workerAndOpus)]).toEqual([1, 1]);
  });

  test('the two COR-2463 expiry traces retain only histories compatible with their recorded expiry and link', () => {
    expect(
      placesAfterEach([
        admit('t0'),
        { kind: 'expire', toolUseId: 't0', at: 1 },
        admit('t1'),
        start('a0', 2),
        launched('t1', 'a0'),
      ]),
    ).toEqual([1, 0, 1, 2, 1]);
    expect(
      placesAfterEach([
        admit('t0'),
        admit('t1'),
        start('a1'),
        { kind: 'expire', toolUseId: 't1', at: 1 },
        start('a0', 2),
        stop('a0', 3),
        stop('a1', 4),
        launched('t1', 'a1'),
      ]),
    ).toEqual([1, 2, 2, 2, 2, 1, 0, 0]);
  });

  test('rejects a stale link without reinstating a dispatch its failure already released', () => {
    const events = [admit('t'), failed('t'), launched('t', 'a')];
    expect(placesAfterEach(events)).toEqual([1, 0, 0]);
    expect(foldSession(events).dispatches.get('t')).toMatchObject({ status: 'failed' });
  });

  test('unobserved type differences do not distinguish equivalent fallback assignments', () => {
    const count = 24;
    const dispatches: SessionEvent[] = Array.from({ length: count }, (_, index) => ({
      ...admit('tool-' + String(index)),
      agentType: 'type-' + String(index),
    }));
    const starts: SessionEvent[] = Array.from({ length: count }, (_, index) => ({
      ...start('agent-' + String(index)),
      agentType: 'unknown-type',
    }));
    const state = foldSession([...dispatches, ...starts]);
    expect(workerPlaces(state)).toBe(count);
    expect(
      [...state.dispatches.values()].filter((dispatch) => dispatch.status === 'started'),
    ).toHaveLength(count);
  });

  test('counts each role after many anonymous starts that cannot be distinguished by future hooks', () => {
    const count = 18;
    const dispatches: SessionEvent[] = Array.from({ length: count }, (_, index) => ({
      ...admit('mixed-tool-' + String(index)),
      readOnly: index % 3 === 0,
      opus: index % 3 === 1,
    }));
    const starts = Array.from({ length: count }, (_, index) =>
      start('mixed-agent-' + String(index)),
    );
    const state = foldSession([...dispatches, ...starts, stop('mixed-agent-0')]);
    expect(workerPlaces(state)).toBe(12);
    expect(readOnlyAgents(state)).toBe(6);
    expect(opusPlaces(state)).toBe(6);
    const linked = applySessionEvent(state, launched('mixed-tool-0', 'mixed-agent-0'));
    expect(workerPlaces(linked)).toBe(12);
    expect(readOnlyAgents(linked)).toBe(5);
    expect(opusPlaces(linked)).toBe(6);
  });

  test('refines dozens of interchangeable starts when delayed links name the reverse order', () => {
    const ids = Array.from({ length: 24 }, (_, index) => String(index));
    let state = foldSession([
      ...ids.map((id): SessionEvent => ({ ...admit(`tool-${id}`), bypass: true })),
      ...ids.map((id) => start(`agent-${id}`)),
    ]);
    expect(workerPlaces(state)).toBe(ids.length);

    for (const [index, agent] of ids.entries()) {
      const tool = ids.at(-1 - index)!;
      state = applySessionEvent(state, launched(`tool-${tool}`, `agent-${agent}`));
      expect(state.dispatches.get(`tool-${tool}`)?.agentId).toBe(`agent-${agent}`);
      expect(workerPlaces(state)).toBe(ids.length);
    }
    for (const [index, agent] of ids.entries()) {
      state = applySessionEvent(state, stop(`agent-${agent}`));
      expect(workerPlaces(state)).toBe(ids.length - index - 1);
    }
  });

  test('does not manufacture an unadmitted start to satisfy a later contradictory link', () => {
    const events = [admit('t'), start('a'), start('b'), launched('t', 'b')];
    expect(placesAfterEach(events)).toEqual([1, 1, 2, 2]);
    expect(foldSession(events).dispatches.get('t')?.agentId).toBe('a');
  });

  test('expires a dispatch only when every compatible history still has it pending', () => {
    const state = foldSession([admit('t0', 0), admit('t1', 1), start('a', 2)]);
    expect(neverStarted(state, neverStartedLimitMilliseconds + 2)).toEqual([]);
  });
});

describe('every interleaving', () => {
  test('of two dispatches of every kind, with repeated stops, holds exactly the admitted-or-running', () => {
    let prefixes = 0;
    const failures: string[] = [];
    for (const kinds of kindSequences(2)) {
      for (const repeatStop of [false, true]) {
        const result = exploreInterleavings(kinds, repeatStop);
        prefixes += result.prefixes;
        failures.push(...result.failures);
      }
    }
    expect(failures).toEqual([]);
    // 16 pairs of kinds, each with and without a repeated stop. The three-dispatch run, about
    // 8.9 million prefixes, is `host-sessions-model.slow.test.ts`.
    expect(prefixes).toBe(35_368);
  });

  const withReclaims = kindSequences(2, [...dispatchKinds, ...reclaimKinds]).filter((kinds) =>
    kinds.some((kind) => reclaimKinds.includes(kind)),
  );

  function exploreReclaims(apply?: ApplyEvent): { prefixes: number; failures: string[] } {
    let prefixes = 0;
    const failures: string[] = [];
    for (const kinds of withReclaims) {
      for (const repeatStop of [false, true]) {
        const result = exploreInterleavings(kinds, repeatStop, apply);
        prefixes += result.prefixes;
        failures.push(...result.failures);
      }
    }
    return { prefixes, failures };
  }

  test('of two dispatches with an expiry or a release, holds exactly the admitted-or-running up to a survey, and never fewer than the running', () => {
    const { prefixes, failures } = exploreReclaims();
    expect(failures).toEqual([]);
    // The 20 pairs with an expired or a released dispatch, each with and without a repeated stop.
    expect(prefixes).toBe(44_180);
  });

  test('fails without the expiry or the release step', () => {
    const without =
      (kind: SessionEvent['kind']): ApplyEvent =>
      (state, event) =>
        event.kind === kind ? state : applySessionEvent(state, event);
    expect(exploreReclaims(without('expire')).failures).not.toEqual([]);
    expect(exploreReclaims(without('release')).failures).not.toEqual([]);
  });
});

describe('Opus places', () => {
  const typed = (toolUseId: string, agentType: string, opus: boolean): SessionEvent => ({
    kind: 'admit',
    toolUseId,
    at: 0,
    description: `Deliver ${toolUseId}`,
    dispatcher: '',
    agentType,
    ...(opus ? { opus } : {}),
  });
  const startTyped = (agentId: string, agentType: string): SessionEvent => ({
    kind: 'start',
    agentId,
    at: 0,
    agentType,
  });

  test('an Opus agent that started second keeps its own place when the Sonnet agent stops first', () => {
    const state = foldSession([
      typed('t-opus', 'chef-reviewer', true),
      typed('t-sonnet', 'chef-worker', false),
      // Sonnet starts first, though its dispatch is the younger one.
      startTyped('a-sonnet', 'chef-worker'),
      startTyped('a-opus', 'chef-reviewer'),
      stop('a-sonnet'),
    ]);
    expect(workerPlaces(state)).toBe(1);
    expect(opusPlaces(state)).toBe(1);
    expect(opusPlaces(applySessionEvent(state, stop('a-opus')))).toBe(0);
  });

  test('a read-only agent holds no worker place, pending or running, and no coordinator place', () => {
    const readOnly: SessionEvent = {
      kind: 'admit',
      toolUseId: 't-ro',
      at: 0,
      description: 'Scout',
      dispatcher: '',
      agentType: 'Explore',
      readOnly: true,
    };
    const pending = foldSession([readOnly]);
    expect(workerPlaces(pending)).toBe(0);
    expect(sessionPlaces(pending)).toBe(0);
    expect(readOnlyAgents(pending)).toBe(1);
    const running = applySessionEvent(pending, startTyped('a-ro', 'Explore'));
    expect([workerPlaces(running), readOnlyAgents(running)]).toEqual([0, 1]);
    expect(readOnlyAgents(applySessionEvent(running, stop('a-ro')))).toBe(0);
  });

  test('a pending Opus dispatch counts, and a dispatch with no model on record counts none', () => {
    expect(opusPlaces(foldSession([typed('t-1', 'general-purpose', true)]))).toBe(1);
    expect(opusPlaces(foldSession([admit('t-1')]))).toBe(0);
  });
});
