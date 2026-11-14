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
  readonly status: DispatchStatus;
  /** The agent that started for it, or the one its `PostToolUse` named before that agent started. */
  readonly agentId?: string | undefined;
  /** Whether `agentId` came from the dispatch's own `PostToolUse` rather than from start order. */
  readonly linked: boolean;
};

export type Agent = {
  readonly agentId: string;
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
    }
  | {
      readonly kind: 'start';
      readonly agentId: string;
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
  let oldest: Dispatch | undefined;
  for (const dispatch of state.dispatches.values()) {
    if (dispatch.status !== 'pending') continue;
    if (dispatch.agentId === agentId) return dispatch;
    if (dispatch.agentId !== undefined) continue;
    if (oldest === undefined) oldest = dispatch;
  }
  return oldest;
}

/**
 * Gives `agentId`'s first run the place of a pending dispatch, the one named for it if any, and
 * resolves to whether there was one.
 */
function takePending(state: Draft, agentId: string): boolean {
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
  const displaced = guessedAgent(dispatch);
  if (dispatch.status === 'pending' || displaced !== undefined) {
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
export function applySessionEvent(state: SessionState, event: SessionEvent): SessionState {
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

export function foldSession(events: readonly SessionEvent[]): SessionState {
  return events.reduce(applySessionEvent, emptySession);
}

/** The session's worker places: one per dispatch waiting for its agent, one per running agent. */
export function workerPlaces(state: SessionState): number {
  let held = 0;
  for (const dispatch of state.dispatches.values()) if (dispatch.status === 'pending') held += 1;
  for (const agent of state.agents.values()) if (agent.running) held += 1;
  return held;
}

/** The session's places: its workers', and its coordinator's while it has any worker. */
export function sessionPlaces(state: SessionState): number {
  const workers = workerPlaces(state);
  return workers + (workers > 0 ? 1 : 0);
}

/** The pending dispatches admitted at least `limit` before `now`, which the next admission expires. */
export function neverStarted(
  state: SessionState,
  now: number,
  limit = neverStartedLimitMilliseconds,
): Dispatch[] {
  return [...state.dispatches.values()].filter(
    (dispatch) => dispatch.status === 'pending' && now - dispatch.admittedAt >= limit,
  );
}
