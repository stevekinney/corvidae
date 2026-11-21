import type { ReplayNames } from './host-sessions-history.ts';
import type { Agent, Dispatch, SessionEvent, SessionState } from './host-sessions-model.ts';

/** Applies hook events to an individual possible history. The model projects across histories. */

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
      if (dispatch.status !== 'pending') return state;
      update(next.dispatches, event.toolUseId, { status: 'failed', agentId: undefined });
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

function startFor(
  state: SessionState,
  event: Extract<SessionEvent, { kind: 'start' }>,
  names: ReplayNames,
): SessionState[] {
  if (state.agents.has(event.agentId)) return [applyCertainEvent(state, event)];
  const forced = names.dispatchByAgent.get(event.agentId);
  const named = [...state.dispatches.values()].find(
    (dispatch) => dispatch.status === 'pending' && dispatch.agentId === event.agentId,
  );
  if (named !== undefined) {
    return forced === undefined || forced === named.toolUseId
      ? [applyCertainEvent(state, event)]
      : [];
  }
  const eligible = [...state.dispatches.values()].filter(
    (dispatch) =>
      (dispatch.status === 'pending' || dispatch.status === 'expired') &&
      dispatch.agentId === undefined,
  );
  const sameType = eligible.filter(
    (dispatch) => event.agentType !== undefined && dispatch.agentType === event.agentType,
  );
  const choices = sameType.length === 0 ? eligible : sameType;
  if (choices.length === 0) {
    return forced === undefined ? [applyCertainEvent(state, event)] : [];
  }
  const anonymous = new Set<string>();
  const compatible = choices.filter((dispatch) => {
    if (forced !== undefined) return dispatch.toolUseId === forced;
    if (names.agentByDispatch.has(dispatch.toolUseId)) return false;
    if (names.dispatches.has(dispatch.toolUseId)) return true;
    // An unclaimed dispatch can only be distinguished by the observed suffix naming its ID,
    // a start preferring its type, or its current lifecycle and accounting state.
    const signature = JSON.stringify([
      dispatch.status,
      dispatch.agentType !== undefined && names.startTypes.has(dispatch.agentType)
        ? dispatch.agentType
        : undefined,
      dispatch.opus === true,
      dispatch.readOnly === true,
    ]);
    if (anonymous.has(signature)) return false;
    anonymous.add(signature);
    return true;
  });
  return compatible.map((dispatch) => {
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

export function advanceSessionHistory(
  state: SessionState,
  event: SessionEvent,
  names: ReplayNames,
): readonly SessionState[] {
  if (event.kind === 'start') return startFor(state, event, names);
  if (
    ((event.kind === 'launched' || event.kind === 'completed') &&
      !compatibleWithLink(state, event)) ||
    (event.kind === 'failed' && !compatibleWithFailure(state, event))
  ) {
    return [];
  }
  return [applyCertainEvent(state, event)];
}
