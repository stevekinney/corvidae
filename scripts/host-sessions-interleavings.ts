/**
 * Every interleaving of the hook events of a few dispatches in one session, for the property tests
 * of `scripts/host-sessions-model.ts`. Each dispatch keeps its own order: its `PreToolUse` first,
 * its agent's start before its stop, its `PostToolUse` after its `PreToolUse`, and a foreground
 * call's result after its agent's stop (or after its start, when the stop never fires).
 */

import {
  applySessionEvent,
  emptySession,
  workerPlaces,
  type SessionEvent,
  type SessionState,
} from './host-sessions-model.ts';

export type DispatchKind = 'background' | 'foreground' | 'foreground-without-stop' | 'failed';

export const dispatchKinds: readonly DispatchKind[] = [
  'background',
  'foreground',
  'foreground-without-stop',
  'failed',
];

type Step = { readonly event: SessionEvent; readonly after: readonly number[] };

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

/**
 * What the dispatches really hold once the flagged events happened: one place for each dispatch
 * admitted and not yet ended (failed, or its agent's run over), and how many agents run.
 */
function truth(kinds: readonly DispatchKind[], done: ReadonlyArray<readonly boolean[]>) {
  let held = 0;
  let running = 0;
  kinds.forEach((kind, index) => {
    const own = done[index] ?? [];
    if (own[0] !== true) return;
    // Index 1 is the failure of a failed dispatch; index 2 the stop, or the result of a
    // foreground call whose stop never fires.
    const ended = kind === 'failed' ? own[1] === true : own[2] === true;
    if (!ended) held += 1;
    if (kind !== 'failed' && own[1] === true && !ended) running += 1;
  });
  return { held, running };
}

/**
 * Visits every interleaving of the dispatches' events, depth first, checking after every prefix
 * that the session holds exactly the admitted-or-running and never fewer than the running.
 * Resolves to how many prefixes it checked and the first few that failed.
 */
export function exploreInterleavings(
  kinds: readonly DispatchKind[],
  repeatStop: boolean,
): { prefixes: number; failures: string[] } {
  const steps = kinds.map((kind, index) => stepsOf(kind, index, repeatStop));
  const done = steps.map((own) => own.map(() => false));
  const failures: string[] = [];
  const trail: SessionEvent[] = [];
  let prefixes = 0;
  const visit = (state: SessionState) => {
    for (const [dispatch, own] of steps.entries()) {
      const flags = done[dispatch];
      if (flags === undefined) continue;
      for (const [index, step] of own.entries()) {
        if (flags[index] === true || !step.after.every((before) => flags[before] === true))
          continue;
        flags[index] = true;
        trail.push(step.event);
        const next = applySessionEvent(state, step.event);
        prefixes += 1;
        const expected = truth(kinds, done);
        const held = workerPlaces(next);
        if ((held !== expected.held || held < expected.running) && failures.length < 3) {
          const order = trail.map(
            (event) =>
              `${event.kind}(${'toolUseId' in event ? event.toolUseId : ''}${'agentId' in event ? ` ${event.agentId}` : ''})`,
          );
          failures.push(
            `${kinds.join(',')}: held ${held}, expected ${expected.held}: ${order.join(' ')}`,
          );
        }
        visit(next);
        trail.pop();
        flags[index] = false;
      }
    }
  };
  visit(emptySession);
  return { prefixes, failures };
}

/** Every sequence of `count` kinds. */
export function kindSequences(count: number): DispatchKind[][] {
  if (count === 0) return [[]];
  return kindSequences(count - 1).flatMap((rest) => dispatchKinds.map((kind) => [...rest, kind]));
}
