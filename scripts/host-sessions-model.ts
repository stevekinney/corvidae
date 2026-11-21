/**
 * The count of one Claude Code session's host places (COR-2455), as a pure fold over the hook
 * events the session's `chef-worker` dispatches produce, in the order they were recorded.
 *
 * Nothing is bound to a place. Within one session a worker's places are interchangeable, so the
 * session holds one place for each admitted dispatch whose agent has not started, and one for each
 * agent that runs: `pending + running`. Running is derived only from `SubagentStart` and
 * `SubagentStop` by `agent_id`, so no other event lowers it below what runs. `SubagentStart` carries
 * no `tool_use_id`, so which pending dispatch a start consumes is decided by order (the oldest one
 * no `PostToolUse` has named for another agent); a later `PostToolUse` that names the agent moves it
 * to its own dispatch. Only which dispatch shows as started depends on that guess, never the count.
 */

export type DispatchStatus = 'pending' | 'started' | 'failed' | 'expired' | 'released' | 'finished';

export type Dispatch = {
  readonly toolUseId: string;
  readonly admittedAt: number;
  readonly description: string;
  readonly issue?: string;
  /** The agent that dispatched it, empty for the session's main agent. */
  readonly dispatcher: string;
  readonly bypass: boolean;
  /** The dispatch's `subagent_type`, when the admission recorded it. */
  readonly agentType?: string;
  /** Whether the dispatch runs on Opus, which the host runs one of at a time. */
  readonly opus?: boolean;
  /** Whether the dispatch's agent type is read-only: no host place, but the read-only cap. */
  readonly readOnly?: boolean;
  readonly status: DispatchStatus;
  /** The agent that started for it, or the one its `PostToolUse` named before that agent started. */
  readonly agentId?: string | undefined;
  /** Whether `agentId` came from the dispatch's own `PostToolUse` rather than from start order. */
  readonly linked: boolean;
};

export type Agent = {
  readonly agentId: string;
  /** The agent's type from its `SubagentStart`; it picks the same-type pending dispatch. */
  readonly agentType?: string;
  /** Whether the agent is read-only, for a run that took no dispatch's place. */
  readonly readOnly?: boolean;
  readonly startedAt: number;
  readonly running: boolean;
  /** How many runs started: more than one once `SendMessage` resumed it. */
  readonly runs: number;
  /** The dispatch whose place the agent's first run took; absent when it took none. */
  readonly toolUseId?: string | undefined;
  /** Whether the current run started without an admission while the host had no place free. */
  readonly overCap: boolean;
};

/** Whether an agent's current run started without taking an admitted dispatch's place. */
export function runsWithoutAdmission(agent: Agent): boolean {
  return agent.runs > 1 || agent.toolUseId === undefined;
}

export type SessionEvent =
  | {
      readonly kind: 'admit';
      readonly toolUseId: string;
      readonly at: number;
      readonly description: string;
      readonly issue?: string;
      readonly dispatcher: string;
      readonly bypass?: boolean;
      /** Optional, so a checkout without these fields folds the same ledger unchanged. */
      readonly agentType?: string;
      readonly opus?: boolean;
      readonly readOnly?: boolean;
    }
  | {
      readonly kind: 'start';
      readonly agentId: string;
      readonly agentType?: string;
      readonly readOnly?: boolean;
      readonly at: number;
      readonly overCap?: boolean;
    }
  | { readonly kind: 'stop'; readonly agentId: string; readonly at: number }
  /** `PostToolUse` of a dispatch moved to the background, naming its agent. */
  | {
      readonly kind: 'launched';
      readonly toolUseId: string;
      readonly agentId: string;
      readonly at: number;
    }
  /** `PostToolUse` of a foreground dispatch that finished; `agentId` may be empty. */
  | {
      readonly kind: 'completed';
      readonly toolUseId: string;
      readonly agentId: string;
      readonly at: number;
    }
  /** `PostToolUseFailure` or `PermissionDenied`: the dispatch failed before its agent started. */
  | { readonly kind: 'failed'; readonly toolUseId: string; readonly at: number }
  /** An admitted dispatch with no start after {@link neverStartedLimitMilliseconds}. */
  | { readonly kind: 'expire'; readonly toolUseId: string; readonly at: number }
  /** The owner or a coordinator freed a dispatch's or an agent's place by hand. */
  | { readonly kind: 'release'; readonly target: string; readonly at: number };

export type SessionState = {
  readonly dispatches: ReadonlyMap<string, Dispatch>;
  readonly agents: ReadonlyMap<string, Agent>;
};

/** How long an admitted dispatch may go without a start before the next admission reclaims it. */
export const neverStartedLimitMilliseconds = 10 * 60 * 1000;

export const emptySession: SessionState = { dispatches: new Map(), agents: new Map() };

type Draft = { dispatches: Map<string, Dispatch>; agents: Map<string, Agent> };

function draft(state: SessionState): Draft {
  return { dispatches: new Map(state.dispatches), agents: new Map(state.agents) };
}

function update<T>(map: Map<string, T>, key: string, change: Partial<T>): void {
  const current = map.get(key);
  if (current !== undefined) map.set(key, { ...current, ...change });
}

/** The oldest pending dispatch no `PostToolUse` has named for another agent. */
function unclaimedPending(state: Draft, agentId: string): Dispatch | undefined {
  const type = state.agents.get(agentId)?.agentType;
  let oldest: Dispatch | undefined;
  let oldestOfType: Dispatch | undefined;
  for (const dispatch of state.dispatches.values()) {
    if (dispatch.status !== 'pending') continue;
    if (dispatch.agentId === agentId) return dispatch;
    if (dispatch.agentId !== undefined) continue;
    oldest ??= dispatch;
    // An agent takes the oldest pending dispatch of its own type, so an Opus place is never
    // given to a Sonnet agent that merely started first.
    if (type !== undefined && dispatch.agentType === type) oldestOfType ??= dispatch;
  }
  return oldestOfType ?? oldest;
}

/**
 * An expired dispatch can still own one late, anonymous start. Prefer it to a newer pending
 * dispatch until that start's `PostToolUse` identifies its real dispatch. A stopped anonymous
 * agent no longer owns the marker, so the next late start may take it instead.
 */
function unmatchedExpiry(state: Draft, agentId: string): Dispatch | undefined {
  const type = state.agents.get(agentId)?.agentType;
  let oldest: Dispatch | undefined;
  let oldestOfType: Dispatch | undefined;
  for (const dispatch of state.dispatches.values()) {
    if (dispatch.status !== 'expired') continue;
    // A late start that has already stopped belongs to this expired dispatch. It cannot make a
    // later, different anonymous start ambiguous again.
    if (dispatch.agentId !== undefined) continue;
    oldest ??= dispatch;
    if (type !== undefined && dispatch.agentType === type) oldestOfType ??= dispatch;
  }
  return oldestOfType ?? oldest;
}

function pendingForAgent(state: Draft, agentId: string): Dispatch | undefined {
  return [...state.dispatches.values()].find(
    (dispatch) => dispatch.status === 'pending' && dispatch.agentId === agentId,
  );
}

/**
 * Gives `agentId`'s first run the place of a pending dispatch, the one named for it if any, and
 * resolves to whether there was one.
 */
function takePending(state: Draft, agentId: string): boolean {
  const linked = pendingForAgent(state, agentId);
  if (linked !== undefined) {
    update(state.dispatches, linked.toolUseId, { status: 'started', linked: true });
    update(state.agents, agentId, { toolUseId: linked.toolUseId });
    return true;
  }
  const expired = unmatchedExpiry(state, agentId);
  if (expired !== undefined) {
    update(state.dispatches, expired.toolUseId, { agentId, linked: false });
    update(state.agents, agentId, { toolUseId: undefined });
    return false;
  }
  const dispatch = unclaimedPending(state, agentId);
  if (dispatch === undefined) {
    update(state.agents, agentId, { toolUseId: undefined });
    return false;
  }
  update(state.dispatches, dispatch.toolUseId, {
    status: 'started',
    agentId,
    linked: dispatch.agentId === agentId,
  });
  update(state.agents, agentId, { toolUseId: dispatch.toolUseId });
  return true;
}

/** The agent that start order gave `toolUseId`, which may be the wrong one; undefined if none. */
function guessedAgent(dispatch: Dispatch): string | undefined {
  return dispatch.status === 'started' && !dispatch.linked ? dispatch.agentId : undefined;
}

/**
 * Records that `toolUseId`'s own `PostToolUse` named `agentId`: a dispatch the agent's start order
 * gave it goes back to pending, and an agent start order gave this dispatch looks for another.
 */
function link(state: Draft, toolUseId: string, agentId: string): void {
  const dispatch = state.dispatches.get(toolUseId);
  if (dispatch === undefined || agentId === '') return;
  if (dispatch.agentId === agentId) {
    const agent = state.agents.get(agentId);
    if (dispatch.status === 'expired') {
      update(state.dispatches, toolUseId, {
        status: agent?.running === true ? 'started' : 'finished',
        linked: true,
      });
      if (agent !== undefined) update(state.agents, agentId, { toolUseId });
      return;
    }
    update(state.dispatches, toolUseId, { linked: true });
    return;
  }
  const agent = state.agents.get(agentId);
  if (agent?.toolUseId !== undefined && agent.toolUseId !== toolUseId) {
    update(state.dispatches, agent.toolUseId, {
      status: 'pending',
      agentId: undefined,
      linked: false,
    });
    update(state.agents, agentId, { toolUseId: undefined });
  }
  const markedExpiry = [...state.dispatches.values()].find(
    (each) => each.status === 'expired' && each.agentId === agentId,
  );
  if (markedExpiry !== undefined) {
    update(state.dispatches, markedExpiry.toolUseId, { agentId: undefined, linked: false });
  }
  const displaced =
    guessedAgent(dispatch) ?? (dispatch.status === 'expired' ? dispatch.agentId : undefined);
  if (dispatch.status === 'pending' || dispatch.status === 'expired' || displaced !== undefined) {
    // The dispatch is claimed for its agent before a displaced agent looks for another.
    const status = agent === undefined ? 'pending' : agent.running ? 'started' : 'finished';
    update(state.dispatches, toolUseId, { status, agentId, linked: true });
    if (agent !== undefined) update(state.agents, agentId, { toolUseId });
  } else {
    // Failed, expired, released or finished first: the agent keeps whatever it holds.
    update(state.dispatches, toolUseId, { agentId, linked: true });
  }
  if (displaced !== undefined) takePending(state, displaced);
}

function stopRun(state: Draft, agentId: string): void {
  const agent = state.agents.get(agentId);
  if (agent?.running === true) update(state.agents, agentId, { running: false, overCap: false });
}

/** The session after one more event. Events a session has already seen change nothing. */
function applyCertainEvent(state: SessionState, event: SessionEvent): SessionState {
  const next = draft(state);
  switch (event.kind) {
    case 'admit': {
      if (next.dispatches.has(event.toolUseId)) return state;
      next.dispatches.set(event.toolUseId, {
        toolUseId: event.toolUseId,
        admittedAt: event.at,
        description: event.description,
        ...(event.issue === undefined ? {} : { issue: event.issue }),
        dispatcher: event.dispatcher,
        bypass: event.bypass === true,
        ...(event.agentType === undefined ? {} : { agentType: event.agentType }),
        ...(event.opus === true ? { opus: true } : {}),
        ...(event.readOnly === true ? { readOnly: true } : {}),
        status: 'pending',
        linked: false,
      });
      return next;
    }
    case 'start': {
      const agent = next.agents.get(event.agentId);
      // A start for a running agent (a teammate's next message) changes nothing.
      if (agent?.running === true) return state;
      if (agent !== undefined) {
        // Resumed by `SendMessage`: a new run, which took no admission.
        update(next.agents, event.agentId, {
          running: true,
          runs: agent.runs + 1,
          overCap: event.overCap === true,
        });
        return next;
      }
      next.agents.set(event.agentId, {
        agentId: event.agentId,
        ...(event.agentType === undefined ? {} : { agentType: event.agentType }),
        ...(event.readOnly === true ? { readOnly: true } : {}),
        startedAt: event.at,
        running: true,
        runs: 1,
        overCap: false,
      });
      if (!takePending(next, event.agentId)) {
        update(next.agents, event.agentId, { overCap: event.overCap === true });
      }
      return next;
    }
    case 'stop': {
      if (!next.agents.has(event.agentId)) {
        // Its start was never recorded: the launched dispatch that named it is over.
        const named = [...next.dispatches.values()].find(
          (dispatch) => dispatch.status === 'pending' && dispatch.agentId === event.agentId,
        );
        if (named === undefined) return state;
        update(next.dispatches, named.toolUseId, { status: 'finished' });
        return next;
      }
      stopRun(next, event.agentId);
      return next;
    }
    case 'launched': {
      link(next, event.toolUseId, event.agentId);
      return next;
    }
    case 'completed': {
      link(next, event.toolUseId, event.agentId);
      // A foreground call that returned ended its agent's first run, whether or not its
      // `SubagentStop` fired: an idempotent stop.
      const agent = next.agents.get(event.agentId);
      if (agent !== undefined && agent.runs === 1) stopRun(next, event.agentId);
      const dispatch = next.dispatches.get(event.toolUseId);
      if (dispatch?.status === 'pending')
        update(next.dispatches, event.toolUseId, { status: 'finished' });
      return next;
    }
    case 'failed': {
      const dispatch = next.dispatches.get(event.toolUseId);
      if (dispatch === undefined) return state;
      const guessed = guessedAgent(dispatch);
      if (dispatch.status !== 'pending' && guessed === undefined) return state;
      update(next.dispatches, event.toolUseId, { status: 'failed', agentId: undefined });
      // Start order gave this dispatch an agent; the failure says none started for it, so that
      // agent's place is another pending dispatch's, if there is one.
      if (guessed !== undefined) takePending(next, guessed);
      return next;
    }
    case 'expire': {
      const dispatch = next.dispatches.get(event.toolUseId);
      if (dispatch?.status !== 'pending') return state;
      update(next.dispatches, event.toolUseId, { status: 'expired' });
      return next;
    }
    case 'release': {
      const dispatch = next.dispatches.get(event.target);
      if (dispatch?.status === 'pending') {
        update(next.dispatches, event.target, { status: 'released' });
      } else if (dispatch?.status === 'started' && dispatch.agentId !== undefined) {
        stopRun(next, dispatch.agentId);
      } else if (next.agents.has(event.target)) {
        stopRun(next, event.target);
      } else return state;
      return next;
    }
  }
}

/** Candidate folds of anonymous starts that the observed hook history has not yet linked. */
const compatibleStates = new WeakMap<SessionState, readonly SessionState[]>();

function candidatesOf(state: SessionState): readonly SessionState[] {
  return compatibleStates.get(state) ?? [state];
}

function historyKey(state: SessionState): string {
  return JSON.stringify([
    [...state.dispatches.values()].map((dispatch) => [
      dispatch.toolUseId,
      dispatch.status,
      dispatch.agentId,
      dispatch.linked,
    ]),
    [...state.agents.values()].map((agent) => [
      agent.agentId,
      agent.running,
      agent.runs,
      agent.toolUseId,
    ]),
  ]);
}

function distinct(states: readonly SessionState[]): SessionState[] {
  const found = new Map<string, SessionState>();
  for (const state of states) found.set(historyKey(state), state);
  return [...found.values()];
}

function startFor(
  state: SessionState,
  event: Extract<SessionEvent, { kind: 'start' }>,
): SessionState[] {
  if (state.agents.has(event.agentId)) return [applyCertainEvent(state, event)];
  const named = [...state.dispatches.values()].find(
    (dispatch) => dispatch.status === 'pending' && dispatch.agentId === event.agentId,
  );
  if (named !== undefined) return [applyCertainEvent(state, event)];
  const eligible = [...state.dispatches.values()].filter(
    (dispatch) =>
      (dispatch.status === 'pending' || dispatch.status === 'expired') &&
      dispatch.agentId === undefined,
  );
  const sameType = eligible.filter(
    (dispatch) => event.agentType !== undefined && dispatch.agentType === event.agentType,
  );
  const choices = sameType.length === 0 ? eligible : sameType;
  if (choices.length === 0) return [applyCertainEvent(state, event)];
  return choices.map((dispatch) => {
    const next = draft(state);
    next.agents.set(event.agentId, {
      agentId: event.agentId,
      ...(event.agentType === undefined ? {} : { agentType: event.agentType }),
      ...(event.readOnly === true ? { readOnly: true } : {}),
      startedAt: event.at,
      running: true,
      runs: 1,
      ...(dispatch.status === 'expired' ? {} : { toolUseId: dispatch.toolUseId }),
      overCap: dispatch.status === 'expired' && event.overCap === true,
    });
    update(next.dispatches, dispatch.toolUseId, {
      status: 'started',
      agentId: event.agentId,
      linked: false,
    });
    return next;
  });
}

function compatibleWithLink(
  state: SessionState,
  event: Extract<SessionEvent, { kind: 'launched' | 'completed' }>,
): boolean {
  const dispatch = state.dispatches.get(event.toolUseId);
  const agent = state.agents.get(event.agentId);
  if (dispatch === undefined || agent === undefined) return true;
  if (agent.toolUseId === event.toolUseId || dispatch.agentId === event.agentId) return true;
  // An agent whose late start took an expired dispatch has no `toolUseId`, but that absence is
  // not a blank cheque for a newer pending dispatch. Another candidate represents that dispatch
  // when it was eligible at the recorded start; retain only that candidate when its link arrives.
  return false;
}

function compatibleWithFailure(
  state: SessionState,
  event: Extract<SessionEvent, { kind: 'failed' }>,
): boolean {
  const dispatch = state.dispatches.get(event.toolUseId);
  return dispatch?.agentId === undefined;
}

function project(states: readonly SessionState[]): SessionState {
  const selected = states.reduce((maximum, candidate) =>
    workerPlacesIn(candidate) > workerPlacesIn(maximum) ? candidate : maximum,
  );
  const result: SessionState = {
    dispatches: new Map(selected.dispatches),
    agents: new Map(selected.agents),
  };
  compatibleStates.set(result, states);
  return result;
}

/**
 * Folds a hook event across every dispatch ownership compatible with anonymous starts, projecting
 * the greatest held count. A later launch or completion event names the dispatch and removes every
 * incompatible candidate.
 */
export function applySessionEvent(state: SessionState, event: SessionEvent): SessionState {
  const before = candidatesOf(state);
  const after =
    event.kind === 'start'
      ? before.flatMap((candidate) => startFor(candidate, event))
      : event.kind === 'launched' || event.kind === 'completed'
        ? before
            .filter((candidate) => compatibleWithLink(candidate, event))
            .map((candidate) => applyCertainEvent(candidate, event))
        : event.kind === 'failed'
          ? before
              .filter((candidate) => compatibleWithFailure(candidate, event))
              .map((candidate) => applyCertainEvent(candidate, event))
          : before.map((candidate) => applyCertainEvent(candidate, event));
  return project(distinct(after.length === 0 ? before : after));
}

export function foldSession(events: readonly SessionEvent[]): SessionState {
  return events.reduce(applySessionEvent, emptySession);
}

/** Whether a running agent is read-only: by the dispatch it took, else by its own start. */
function agentReadOnly(state: SessionState, agent: Agent): boolean {
  if (agent.toolUseId === undefined) return agent.readOnly === true;
  return state.dispatches.get(agent.toolUseId)?.readOnly === true;
}

/**
 * The session's worker places: one per implementation dispatch waiting for its agent, one per
 * running implementation agent. Read-only agents take none (they count in {@link readOnlyAgents}).
 */
export function workerPlaces(state: SessionState): number {
  return Math.max(...candidatesOf(state).map(workerPlacesIn));
}

function workerPlacesIn(state: SessionState): number {
  let held = 0;
  for (const dispatch of state.dispatches.values()) {
    if (dispatch.status === 'pending' && dispatch.readOnly !== true) held += 1;
  }
  for (const agent of state.agents.values()) {
    if (agent.running && !agentReadOnly(state, agent)) held += 1;
  }
  return held;
}

/** The read-only agents the session holds: pending dispatches and running agents. */
export function readOnlyAgents(state: SessionState): number {
  return Math.max(...candidatesOf(state).map(readOnlyAgentsIn));
}

function readOnlyAgentsIn(state: SessionState): number {
  let held = 0;
  for (const dispatch of state.dispatches.values()) {
    if (dispatch.status === 'pending' && dispatch.readOnly === true) held += 1;
  }
  for (const agent of state.agents.values()) {
    if (agent.running && agentReadOnly(state, agent)) held += 1;
  }
  return held;
}

/**
 * The session's places: its implementation workers', and its coordinator's while it has any. A
 * session that is only registered, or that has only read-only agents, holds none.
 */
export function sessionPlaces(state: SessionState): number {
  const workers = workerPlaces(state);
  return workers + (workers > 0 ? 1 : 0);
}

/**
 * The Opus agents the session holds: one for each pending Opus dispatch and one for each running
 * agent that took an Opus dispatch's place. An agent that took none (a resume, say) has no model
 * on record and counts none.
 */
export function opusPlaces(state: SessionState): number {
  return Math.max(...candidatesOf(state).map(opusPlacesIn));
}

function opusPlacesIn(state: SessionState): number {
  let held = 0;
  for (const dispatch of state.dispatches.values()) {
    if (dispatch.opus === true && dispatch.status === 'pending') held += 1;
  }
  for (const agent of state.agents.values()) {
    if (!agent.running || agent.toolUseId === undefined) continue;
    if (state.dispatches.get(agent.toolUseId)?.opus === true) held += 1;
  }
  return held;
}

/** The pending dispatches admitted at least `limit` before `now`, which the next admission expires. */
export function neverStarted(
  state: SessionState,
  now: number,
  limit = neverStartedLimitMilliseconds,
): Dispatch[] {
  const candidates = candidatesOf(state);
  return [...state.dispatches.values()].filter((dispatch) =>
    candidates.every((candidate) => {
      const possible = candidate.dispatches.get(dispatch.toolUseId);
      // A dispatch its `PostToolUse` launched as a named agent has started, whether or not its
      // `SubagentStart` was recorded; it keeps its place until that agent's stop.
      return (
        possible?.status === 'pending' &&
        possible.agentId === undefined &&
        now - possible.admittedAt >= limit
      );
    }),
  );
}
