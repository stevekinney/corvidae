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

type ActualDispatch = {
  readonly status: 'pending' | 'expired' | 'started' | 'ended';
  readonly agentId?: string;
};

type ActualAgent = { readonly running: boolean; readonly dispatchId?: string };

type CompatibleHistory = {
  readonly dispatches: ReadonlyMap<string, ActualDispatch>;
  readonly agents: ReadonlyMap<string, ActualAgent>;
};

const emptyHistory: CompatibleHistory = { dispatches: new Map(), agents: new Map() };

function copyHistory(history: CompatibleHistory) {
  return { dispatches: new Map(history.dispatches), agents: new Map(history.agents) };
}

function heldBy(history: CompatibleHistory): number {
  let held = 0;
  for (const dispatch of history.dispatches.values()) {
    if (dispatch.status === 'pending' || dispatch.status === 'started') held += 1;
  }
  for (const agent of history.agents.values()) {
    if (agent.running && agent.dispatchId === undefined) held += 1;
  }
  return held;
}

/**
 * Enumerates physical histories compatible with observed hooks. A `SubagentStart` lacks a tool-use
 * identity, so it branches across every dispatch it could have started. Its greatest held count is
 * the required safe reservation until `PostToolUse` supplies that missing link.
 */
function compatibleAfter(history: CompatibleHistory, event: SessionEvent): CompatibleHistory[] {
  if (event.kind === 'admit') {
    const next = copyHistory(history);
    next.dispatches.set(event.toolUseId, { status: 'pending' });
    return [next];
  }
  if (event.kind === 'expire') {
    const next = copyHistory(history);
    const dispatch = next.dispatches.get(event.toolUseId);
    if (dispatch?.status === 'pending')
      next.dispatches.set(event.toolUseId, { ...dispatch, status: 'expired' });
    return [next];
  }
  if (event.kind === 'start') {
    const known = history.agents.get(event.agentId);
    if (known !== undefined) {
      const next = copyHistory(history);
      next.agents.set(event.agentId, { ...known, running: true });
      return [next];
    }
    const linked = [...history.dispatches.entries()].find(
      ([, dispatch]) => dispatch.agentId === event.agentId,
    );
    if (linked !== undefined) {
      const [toolUseId, dispatch] = linked;
      const next = copyHistory(history);
      next.dispatches.set(toolUseId, { ...dispatch, status: 'started' });
      next.agents.set(event.agentId, { running: true, dispatchId: toolUseId });
      return [next];
    }
    const choices = [...history.dispatches.entries()].filter(
      ([, dispatch]) =>
        (dispatch.status === 'pending' || dispatch.status === 'expired') &&
        dispatch.agentId === undefined,
    );
    if (choices.length === 0) {
      const next = copyHistory(history);
      next.agents.set(event.agentId, { running: true });
      return [next];
    }
    return choices.map(([toolUseId, dispatch]) => {
      const next = copyHistory(history);
      next.dispatches.set(toolUseId, { ...dispatch, status: 'started', agentId: event.agentId });
      next.agents.set(event.agentId, { running: true, dispatchId: toolUseId });
      return next;
    });
  }
  if (event.kind === 'stop') {
    const next = copyHistory(history);
    const agent = next.agents.get(event.agentId);
    if (agent === undefined) {
      const dispatch = [...next.dispatches.entries()].find(
        ([, each]) => each.agentId === event.agentId,
      );
      if (dispatch !== undefined)
        next.dispatches.set(dispatch[0], { ...dispatch[1], status: 'ended' });
      return [next];
    }
    next.agents.set(event.agentId, { ...agent, running: false });
    if (agent.dispatchId !== undefined) {
      const dispatch = next.dispatches.get(agent.dispatchId);
      if (dispatch !== undefined)
        next.dispatches.set(agent.dispatchId, { ...dispatch, status: 'ended' });
    }
    return [next];
  }
  if (event.kind === 'failed') {
    const dispatch = history.dispatches.get(event.toolUseId);
    if (dispatch?.agentId !== undefined) return [];
    const next = copyHistory(history);
    if (dispatch !== undefined)
      next.dispatches.set(event.toolUseId, { ...dispatch, status: 'ended' });
    return [next];
  }
  if (event.kind === 'release') {
    const next = copyHistory(history);
    const dispatch = next.dispatches.get(event.target);
    if (dispatch !== undefined) next.dispatches.set(event.target, { ...dispatch, status: 'ended' });
    const agent = next.agents.get(event.target);
    if (agent !== undefined) {
      next.agents.set(event.target, { ...agent, running: false });
      if (agent.dispatchId !== undefined) {
        const owned = next.dispatches.get(agent.dispatchId);
        if (owned !== undefined)
          next.dispatches.set(agent.dispatchId, { ...owned, status: 'ended' });
      }
    }
    return [next];
  }
  const dispatch = history.dispatches.get(event.toolUseId);
  if (dispatch === undefined) return [history];
  const agent = history.agents.get(event.agentId);
  if (dispatch.agentId !== undefined && dispatch.agentId !== event.agentId) return [];
  if (agent?.dispatchId !== undefined && agent.dispatchId !== event.toolUseId) return [];
  const next = copyHistory(history);
  const running = agent?.running === true;
  next.dispatches.set(event.toolUseId, {
    ...dispatch,
    agentId: event.agentId,
    status: event.kind === 'completed' || (agent !== undefined && !running) ? 'ended' : 'started',
  });
  if (event.kind === 'completed') {
    if (agent !== undefined)
      next.agents.set(event.agentId, { ...agent, running: false, dispatchId: event.toolUseId });
  } else if (agent === undefined) {
    next.agents.set(event.agentId, { running: true, dispatchId: event.toolUseId });
  }
  return [next];
}

function maximumCompatiblePlaces(events: readonly (SessionEvent | 'survey')[]): number {
  let histories = [emptyHistory];
  for (const event of events) {
    if (event !== 'survey') {
      histories = histories.flatMap((history) => compatibleAfter(history, event));
      continue;
    }
    const expired = [...(histories[0]?.dispatches.keys() ?? [])].filter((toolUseId) =>
      histories.every((history) => {
        const dispatch = history.dispatches.get(toolUseId);
        return dispatch?.status === 'pending' && dispatch.agentId === undefined;
      }),
    );
    histories = histories.map((history) => {
      const next = copyHistory(history);
      for (const toolUseId of expired) next.dispatches.set(toolUseId, { status: 'expired' });
      return next;
    });
  }
  return Math.max(0, ...histories.map(heldBy));
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
 * that the session holds exactly the admitted-or-running.
 * Resolves to how many prefixes it checked and the first few that failed.
 *
 * A survey expires only dispatches with no recorded start. A late start therefore takes an expired
 * dispatch before it can consume a newer pending dispatch, which keeps the model conservative
 * until a later `PostToolUse` supplies the missing identity (COR-2506).
 */
export function exploreInterleavings(
  kinds: readonly DispatchKind[],
  repeatStop: boolean,
  apply: ApplyEvent = applySessionEvent,
): { prefixes: number; failures: string[] } {
  const steps = kinds.map((kind, index) => stepsOf(kind, index, repeatStop));
  const done = steps.map((own) => own.map(() => false));
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
        if (step.event === 'survey') surveys += 1;
        flags[index] = true;
        trail.push(step.event);
        const next = step.event === 'survey' ? survey(state, apply) : apply(state, step.event);
        prefixes += 1;
        const expected = maximumCompatiblePlaces(trail);
        const held = workerPlaces(next);
        const wrong = held !== expected;
        if (wrong && failures.length < 3) {
          failures.push(
            `${kinds.join(',')}: held ${held}, expected ${expected}: ${trail.map(describeStep).join(' ')}`,
          );
        }
        visit(next);
        trail.pop();
        flags[index] = false;
        if (step.event === 'survey') surveys -= 1;
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
