import type { Agent, Dispatch, SessionEvent, SessionState } from './host-sessions-model.ts';

/** The reservation was returned before the agent was recorded starting. */
export function reservationReturned(dispatch: Dispatch): boolean {
  return dispatch.status === 'expired' || dispatch.status === 'released';
}

/** Identity names still observable in this replay. A later hook causes a new replay. */
export interface ReplayNames {
  readonly dispatches: ReadonlyMap<string, number>;
  readonly startTypes: ReadonlyMap<string, number>;
  readonly agents: ReadonlyMap<string, number>;
  readonly dispatchByAgent: ReadonlyMap<string, string>;
  readonly agentByDispatch: ReadonlyMap<string, string>;
}

/** A link constrains the start only if the start was already observed when the link arrived. */
function replayNames(
  initial: SessionState,
  events: readonly SessionEvent[],
  distinguished: string | undefined,
): (ReplayNames & { unobservedLinks: ReadonlySet<number> }) | null {
  const dispatches = new Map<string, number>();
  const startTypes = new Map<string, number>();
  const agents = new Map<string, number>();
  const dispatchByAgent = new Map<string, string>();
  const agentByDispatch = new Map<string, string>();
  const unobservedLinks = new Set<number>();
  const admitted = new Set(initial.dispatches.keys());
  const started = new Set(initial.agents.keys());
  if (distinguished !== undefined) dispatches.set(distinguished, Number.POSITIVE_INFINITY);
  for (const [index, event] of events.entries()) {
    const mention = referredDispatch(event);
    if (mention !== undefined) dispatches.set(mention, (dispatches.get(mention) ?? 0) + 1);
    const agentName = referredAgent(event);
    if (agentName !== undefined) agents.set(agentName, (agents.get(agentName) ?? 0) + 1);
    if (event.kind === 'start') {
      started.add(event.agentId);
      if (event.agentType !== undefined) {
        startTypes.set(event.agentType, (startTypes.get(event.agentType) ?? 0) + 1);
      }
    }
    if (event.kind === 'admit') admitted.add(event.toolUseId);
    if ((event.kind !== 'launched' && event.kind !== 'completed') || event.agentId === '') {
      continue;
    }
    if (!admitted.has(event.toolUseId) || !started.has(event.agentId)) {
      unobservedLinks.add(index);
      continue;
    }
    const otherDispatch = dispatchByAgent.get(event.agentId);
    const otherAgent = agentByDispatch.get(event.toolUseId);
    if (
      (otherDispatch !== undefined && otherDispatch !== event.toolUseId) ||
      (otherAgent !== undefined && otherAgent !== event.agentId)
    ) {
      return null;
    }
    dispatchByAgent.set(event.agentId, event.toolUseId);
    agentByDispatch.set(event.toolUseId, event.agentId);
  }
  return { dispatches, startTypes, agents, dispatchByAgent, agentByDispatch, unobservedLinks };
}

function referredDispatch(event: SessionEvent): string | undefined {
  if (event.kind === 'release') return event.target;
  if (event.kind === 'admit' || event.kind === 'start' || event.kind === 'stop') return undefined;
  return event.toolUseId;
}

function referredAgent(event: SessionEvent): string | undefined {
  if (event.kind === 'release') return event.target;
  return 'agentId' in event ? event.agentId : undefined;
}

/** Histories with identical current ownership and liveness have the same future transitions. */
function orderedHistoryKey(state: SessionState): string {
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
      agent.overCap,
      agent.returnedReservation === true,
    ]),
  ]);
}

/**
 * Otherwise preserve the exact state of each named dispatch and collapse the unobservable
 * IDs. Equal unnamed pending or expired dispatches have the same eligibility and accounting
 * roles. An assignment to an unnamed dispatch still gives its agent those roles.
 */
function projectedHistoryKey(state: SessionState, names: ReplayNames): string {
  const identified = (dispatch: Dispatch) =>
    names.dispatches.has(dispatch.toolUseId) ||
    (dispatch.status === 'pending' && dispatch.agentId !== undefined);
  const dispatchKey = (dispatch: Dispatch) =>
    JSON.stringify([
      dispatch.status,
      dispatch.opus === true,
      dispatch.readOnly === true,
      dispatch.agentType !== undefined && names.startTypes.has(dispatch.agentType)
        ? dispatch.agentType
        : undefined,
      dispatch.agentId !== undefined,
    ]);
  const agentKey = (agent: Agent) => {
    const dispatch =
      agent.toolUseId === undefined ? undefined : state.dispatches.get(agent.toolUseId);
    return JSON.stringify([
      names.agents.has(agent.agentId) ? agent.agentId : undefined,
      agent.running,
      agent.runs,
      agent.overCap,
      agent.returnedReservation === true,
      dispatch !== undefined && identified(dispatch) ? dispatch.toolUseId : undefined,
      dispatch?.opus === true,
      dispatch === undefined ? agent.readOnly === true : dispatch.readOnly === true,
    ]);
  };
  const dispatches = [...state.dispatches.values()];
  return JSON.stringify([
    dispatches
      .filter(identified)
      .map((dispatch) => [dispatch.toolUseId, dispatch.status, dispatch.agentId, dispatch.linked]),
    dispatches
      .filter(
        (dispatch) =>
          !identified(dispatch) && (dispatch.status === 'pending' || reservationReturned(dispatch)),
      )
      .map(dispatchKey)
      .toSorted(),
    [...state.agents.values()].map(agentKey).toSorted(),
  ]);
}

function consumeMention(remaining: Map<string, number>, mention: string | undefined): void {
  if (mention === undefined) return;
  const count = remaining.get(mention) ?? 0;
  if (count <= 1) remaining.delete(mention);
  else remaining.set(mention, count - 1);
}

type Transition = (
  state: SessionState,
  event: SessionEvent,
  names: ReplayNames,
) => readonly SessionState[];

/**
 * Replays the observed prefix without permanently choosing any anonymous assignment. For a given
 * pass the transition may give one representative of interchangeable choices. A later link or a
 * survey's question about one dispatch gives that ID a name in the next pass, so neither relies on
 * which representative the earlier pass chose.
 */
export function replayHistories(
  initial: SessionState,
  events: readonly SessionEvent[],
  advance: Transition,
  distinguished?: string,
): readonly SessionState[] {
  const names = replayNames(initial, events, distinguished);
  if (names === null) return [];
  const remaining = {
    ...names,
    dispatches: new Map(names.dispatches),
    startTypes: new Map(names.startTypes),
    agents: new Map(names.agents),
  };
  let candidates = [initial];
  let unobservedLinks = names.unobservedLinks.size;
  for (const [index, event] of events.entries()) {
    consumeMention(remaining.dispatches, referredDispatch(event));
    if (event.kind === 'start') consumeMention(remaining.startTypes, event.agentType);
    consumeMention(remaining.agents, referredAgent(event));
    if (names.unobservedLinks.has(index)) unobservedLinks -= 1;
    let first: SessionState | undefined;
    let alternatives: Map<string, SessionState> | undefined;
    // A result naming an agent with no recorded start can displace an anonymous owner using
    // dispatch order. Preserve the ordered state until such a result is handled.
    const keyOf = (state: SessionState) =>
      unobservedLinks > 0 ? orderedHistoryKey(state) : projectedHistoryKey(state, remaining);
    for (const candidate of candidates) {
      for (const result of advance(candidate, event, remaining)) {
        if (first === undefined) {
          first = result;
          continue;
        }
        alternatives ??= new Map([[keyOf(first), first]]);
        const key = keyOf(result);
        if (!alternatives.has(key)) alternatives.set(key, result);
      }
    }
    if (first === undefined) return [];
    candidates = alternatives === undefined ? [first] : [...alternatives.values()];
  }
  return candidates;
}
