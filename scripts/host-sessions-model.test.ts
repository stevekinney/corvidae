import { describe, expect, test } from 'bun:test';

import { exploreInterleavings, kindSequences } from './host-sessions-interleavings.ts';
import {
  applySessionEvent,
  emptySession,
  foldSession,
  neverStarted,
  neverStartedLimitMilliseconds,
  runsWithoutAdmission,
  sessionPlaces,
  workerPlaces,
  type SessionEvent,
  type SessionState,
} from './host-sessions-model.ts';

const admit = (toolUseId: string, at = 0): SessionEvent => ({
  kind: 'admit',
  toolUseId,
  at,
  description: `Deliver ${toolUseId}`,
  dispatcher: '',
});
const start = (agentId: string, at = 0): SessionEvent => ({ kind: 'start', agentId, at });
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

  test('a release frees a pending dispatch or a running agent', () => {
    const events: SessionEvent[] = [
      admit('tA'),
      admit('tB'),
      start('a'),
      { kind: 'release', target: 'tB', at: 0 },
      { kind: 'release', target: 'a', at: 0 },
    ];
    expect(placesAfterEach(events)).toEqual([1, 2, 2, 1, 0]);
  });

  test('a launched dispatch whose start was never recorded keeps its place past the limit, and its stop returns it', () => {
    const events = [admit('tA', 0), launched('tA', 'a')];
    const state = foldSession(events);
    expect(neverStarted(state, neverStartedLimitMilliseconds * 3)).toEqual([]);
    expect(workerPlaces(state)).toBe(1);
    expect(placesAfterEach([...events, stop('a'), stop('a')])).toEqual([1, 1, 0, 0]);
  });

  test('only a pending dispatch older than the limit counts as never started', () => {
    const state = foldSession([admit('tA', 0), admit('tB', 5), start('a', 6)]);
    expect(neverStarted(state, neverStartedLimitMilliseconds + 4).map((d) => d.toolUseId)).toEqual(
      [],
    );
    expect(neverStarted(state, neverStartedLimitMilliseconds + 5).map((d) => d.toolUseId)).toEqual([
      'tB',
    ]);
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
});
