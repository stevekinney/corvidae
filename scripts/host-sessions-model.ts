import { replayHistories } from './host-sessions-history.ts';
import { advanceSessionHistory } from './host-sessions-transitions.ts';

/**
 * The count of one Claude Code session's host places (COR-2455), as a pure fold over the hook
 * events the session's `chef-worker` dispatches produce, in the order they were recorded.
 *
 * The session holds one place per admitted dispatch still pending and one per running agent.
 * A SubagentStart names the agent and its type; it does not name its dispatch. The fold keeps the
 * possible assignments consistent with that hook and later evidence, using the greatest possible
 * count for each cap. PostToolUse links resolve an assignment; an unobserved link cannot decide
 * which dispatch to expire. The maps present one compatible history for diagnostics.
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
  /** The dispatch for the agent's first run, when it came from a recorded dispatch. */
  readonly toolUseId?: string | undefined;
  /** Its first start arrived after the dispatch's reservation had been returned. */
  readonly returnedReservation?: boolean;
  /** Whether the current run started without an admission while the host had no place free. */
  readonly overCap: boolean;
};

/** Whether an agent's current run started without taking an admitted dispatch's place. */
export function runsWithoutAdmission(agent: Agent): boolean {
  return agent.runs > 1 || agent.toolUseId === undefined || agent.returnedReservation === true;
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

type Observation = {
  readonly initial: SessionState;
  readonly events: readonly SessionEvent[];
  readonly candidates: readonly SessionState[];
};

const observations = new WeakMap<SessionState, Observation>();

function candidatesOf(state: SessionState): readonly SessionState[] {
  return observations.get(state)?.candidates ?? [state];
}

function project(observation: Observation): SessionState {
  const selected = observation.candidates.reduce((maximum, candidate) =>
    workerPlacesIn(candidate) > workerPlacesIn(maximum) ? candidate : maximum,
  );
  const result: SessionState = {
    dispatches: new Map(selected.dispatches),
    agents: new Map(selected.agents),
  };
  observations.set(result, observation);
  return result;
}

/**
 * Counts the greatest reservation supported by the observed prefix. A later named link can
 * distinguish histories that counted alike before it arrived.
 */
export function applySessionEvent(state: SessionState, event: SessionEvent): SessionState {
  // Every compatible history contains the same admitted and observed agent IDs.
  if (
    event.kind === 'release' &&
    !state.dispatches.has(event.target) &&
    !state.agents.has(event.target)
  ) {
    return state;
  }
  const previous = observations.get(state);
  const initial = previous?.initial ?? state;
  const events = [...(previous?.events ?? []), event];
  const candidates = replayHistories(initial, events, advanceSessionHistory);
  // A stale event contradicting every possible parse cannot replace the prior observation.
  return candidates.length === 0 ? state : project({ initial, events, candidates });
}

export function foldSession(events: readonly SessionEvent[]): SessionState {
  const candidates = replayHistories(emptySession, events, advanceSessionHistory);
  return candidates.length === 0
    ? events.reduce(applySessionEvent, emptySession)
    : project({ initial: emptySession, events: [...events], candidates });
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
  const history = observations.get(state);
  return [...state.dispatches.values()].filter((dispatch) => {
    const pending = (each: Dispatch | undefined) =>
      each?.status === 'pending' && each.agentId === undefined && now - each.admittedAt >= limit;
    if (!pending(dispatch)) return false;
    if (history === undefined) return true;
    // Replaying with this ID distinguished tests every possible status for this specific dispatch.
    const candidates = replayHistories(
      history.initial,
      history.events,
      advanceSessionHistory,
      dispatch.toolUseId,
    );
    return (
      candidates.length > 0 &&
      candidates.every((candidate) => pending(candidate.dispatches.get(dispatch.toolUseId)))
    );
  });
}
