/**
 * Every interleaving of the hook events of a few dispatches in one session, for the property tests
 * of `scripts/host-sessions-model.ts`. Each dispatch keeps its own order: its `PreToolUse` first,
 * its agent's start before its stop, its `PostToolUse` after its `PreToolUse`, and a foreground
 * call's result after its agent's stop (or after its start, when the stop never fires).
 *
 * Two kinds exercise what the host does to a session besides its hooks (COR-2463). An `expired`
 * dispatch brings a survey, the next admission's expiry of every dispatch that has not started,
 * at any point after its admission; its agent may start before the survey or after it, when it runs
 * without an admission. A `released` dispatch's agent is freed by hand, by its agent id, while it
 * runs; its stop may come later and returns nothing more.
 */

import {
  applySessionEvent,
  emptySession,
  neverStarted,
  workerPlaces,
  type SessionEvent,
  type SessionState,
} from './host-sessions-model.ts';

export type DispatchKind =
  'background' | 'foreground' | 'foreground-without-stop' | 'failed' | 'expired' | 'released';

export const dispatchKinds: readonly DispatchKind[] = [
  'background',
  'foreground',
  'foreground-without-stop',
  'failed',
];

/** The kinds that exercise the host's expiry and a release by hand. */
export const reclaimKinds: readonly DispatchKind[] = ['expired', 'released'];

/** How the session's state takes one event; the model's own by default, a mutant in a test. */
export type ApplyEvent = (state: SessionState, event: SessionEvent) => SessionState;

/** One step: a hook event, or the next admission's survey, which expires what never started. */
type Step = { readonly event: SessionEvent | 'survey'; readonly after: readonly number[] };

/** Which of a kind's steps start its agent, end its place, and name its agent from `PostToolUse`. */
type Roles = {
  readonly start?: number;
  readonly ends: readonly number[];
  readonly launched?: number;
};

const roles: Readonly<Record<DispatchKind, Roles>> = {
  background: { start: 1, ends: [2], launched: 3 },
  foreground: { start: 1, ends: [2] },
  'foreground-without-stop': { start: 1, ends: [2] },
  failed: { ends: [1] },
  expired: { start: 2, ends: [3] },
  released: { start: 1, ends: [2, 3] },
};

function stepsOf(kind: DispatchKind, index: number, repeatStop: boolean): Step[] {
  const toolUseId = `t${index}`;
  const agentId = `a${index}`;
  const admit: Step = {
    event: { kind: 'admit', toolUseId, at: index, description: '', dispatcher: '' },
    after: [],
  };
  const start: Step = { event: { kind: 'start', agentId, at: 0 }, after: [0] };
  if (kind === 'failed')
    return [admit, { event: { kind: 'failed', toolUseId, at: 0 }, after: [0] }];
  if (kind === 'foreground-without-stop') {
    return [admit, start, { event: { kind: 'completed', toolUseId, agentId, at: 0 }, after: [1] }];
  }
  if (kind === 'expired') {
    return [
      admit,
      { event: 'survey', after: [0] },
      start,
      { event: { kind: 'stop', agentId, at: 0 }, after: [2] },
    ];
  }
  if (kind === 'released') {
    return [
      admit,
      start,
      { event: { kind: 'release', target: agentId, at: 0 }, after: [1] },
      { event: { kind: 'stop', agentId, at: 0 }, after: [1] },
    ];
  }
  const stop: Step = { event: { kind: 'stop', agentId, at: 0 }, after: [1] };
  const steps: Step[] = [
    admit,
    start,
    stop,
    kind === 'background'
      ? { event: { kind: 'launched', toolUseId, agentId, at: 0 }, after: [0] }
      : { event: { kind: 'completed', toolUseId, agentId, at: 0 }, after: [2] },
  ];
  if (repeatStop) steps.push({ event: { kind: 'stop', agentId, at: 0 }, after: [2] });
  return steps;
}

function hasDone(own: readonly boolean[], index: number | undefined): boolean {
  return index !== undefined && own[index] === true;
}

function ended(kind: DispatchKind, own: readonly boolean[]): boolean {
  return roles[kind].ends.some((index) => own[index] === true);
}

/**
 * The dispatches a survey expires, as the host sees them: admitted, ended by nothing, and with no
 * agent started for it or named by its `PostToolUse`.
 */
function expiredBySurvey(
  kinds: readonly DispatchKind[],
  done: ReadonlyArray<readonly boolean[]>,
): number[] {
  const expired: number[] = [];
  kinds.forEach((kind, index) => {
    const own = done[index] ?? [];
    const { start, launched } = roles[kind];
    if (own[0] === true && !ended(kind, own) && !hasDone(own, start) && !hasDone(own, launched))
      expired.push(index);
  });
  return expired;
}

/**
 * What the dispatches really hold once the flagged events happened: one place for each dispatch
 * admitted and not yet ended (failed, its agent's run over, or released), unless a survey expired it
 * before its agent started; and how many agents run.
 */
function truth(
  kinds: readonly DispatchKind[],
  done: ReadonlyArray<readonly boolean[]>,
  expired: readonly boolean[],
) {
  let held = 0;
  let running = 0;
  kinds.forEach((kind, index) => {
    const own = done[index] ?? [];
    if (own[0] !== true || ended(kind, own)) return;
    const started = hasDone(own, roles[kind].start);
    if (started || expired[index] !== true) held += 1;
    if (started) running += 1;
  });
  return { held, running };
}

function survey(state: SessionState, apply: ApplyEvent): SessionState {
  let next = state;
  for (const dispatch of neverStarted(state, Number.POSITIVE_INFINITY, 0)) {
    next = apply(next, { kind: 'expire', toolUseId: dispatch.toolUseId, at: 0 });
  }
  return next;
}

function describeStep(event: SessionEvent | 'survey'): string {
  if (event === 'survey') return 'survey';
  const target = 'target' in event ? event.target : '';
  return `${event.kind}(${'toolUseId' in event ? event.toolUseId : ''}${'agentId' in event ? ` ${event.agentId}` : ''}${target})`;
}

/**
 * Visits every interleaving of the dispatches' events, depth first, checking after every prefix
 * that the session holds exactly the admitted-or-running and never fewer than the running.
 * Resolves to how many prefixes it checked and the first few that failed.
 *
 * After a survey only the second holds. A survey expires the dispatches the ledger shows pending,
 * and when start order gave a pending place to another agent, those are not the dispatches whose
 * agents never started; no event says which they were, so what an event after the survey should
 * leave held is not determined. Two such orders are known to miscount by one until a later event
 * or survey corrects them (COR-2463): an expired dispatch's agent that starts late takes another
 * pending dispatch's place, and a `PostToolUse` that corrects start order after a survey puts back
 * a pending place the survey had expired. The survey itself is checked exactly.
 */
export function exploreInterleavings(
  kinds: readonly DispatchKind[],
  repeatStop: boolean,
  apply: ApplyEvent = applySessionEvent,
): { prefixes: number; failures: string[] } {
  const steps = kinds.map((kind, index) => stepsOf(kind, index, repeatStop));
  const done = steps.map((own) => own.map(() => false));
  const expired = kinds.map(() => false);
  const failures: string[] = [];
  const trail: Array<SessionEvent | 'survey'> = [];
  let surveys = 0;
  let prefixes = 0;
  const visit = (state: SessionState) => {
    for (const [dispatch, own] of steps.entries()) {
      const flags = done[dispatch];
      if (flags === undefined) continue;
      for (const [index, step] of own.entries()) {
        if (flags[index] === true || !step.after.every((before) => flags[before] === true))
          continue;
        const surveyed = surveys > 0;
        const expiredHere = step.event === 'survey' ? expiredBySurvey(kinds, done) : [];
        const wasExpired = expiredHere.map((each) => expired[each] === true);
        for (const each of expiredHere) expired[each] = true;
        if (step.event === 'survey') surveys += 1;
        flags[index] = true;
        trail.push(step.event);
        const next = step.event === 'survey' ? survey(state, apply) : apply(state, step.event);
        prefixes += 1;
        const expected = truth(kinds, done, expired);
        const held = workerPlaces(next);
        const wrong = held < expected.running || (!surveyed && held !== expected.held);
        if (wrong && failures.length < 3) {
          failures.push(
            `${kinds.join(',')}: held ${held}, expected ${expected.held}: ${trail.map(describeStep).join(' ')}`,
          );
        }
        visit(next);
        trail.pop();
        flags[index] = false;
        if (step.event === 'survey') surveys -= 1;
        expiredHere.forEach((each, position) => {
          expired[each] = wasExpired[position] === true;
        });
      }
    }
  };
  visit(emptySession);
  return { prefixes, failures };
}

/** Every sequence of `count` kinds. */
export function kindSequences(
  count: number,
  kinds: readonly DispatchKind[] = dispatchKinds,
): DispatchKind[][] {
  if (count === 0) return [[]];
  return kindSequences(count - 1, kinds).flatMap((rest) => kinds.map((kind) => [...rest, kind]));
}
