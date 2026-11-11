/**
 * Schedule operations (COR-2376 slice S5): create, read, list, pause, resume, reassign, cancel,
 * update, skip, run now and the missed-fire list of a schedule, with the transition outbox that
 * records each change to its history. Built by `constructBureau` and reached only through
 * `createBureau`. The missed-fire replay and the boot tail call into it, so its factory runs
 * before the construction `try` block.
 */
import { AUDIT_SCHEDULE_OWNER_PREFIX } from '../audit-trail';
import type { AgentDefinitions } from '../agent-catalog';
import type { BureauCore } from './core';
import {
  BureauError,
  ScheduleLocatorUnavailableError,
  UnknownScheduleAgentError,
  toBadRequest,
} from '../bureau-errors';
import type {
  CreateScheduleOptions,
  DurableScheduleDefinition,
  DurableScheduleUpdate,
  ScheduleRevisionGuard,
} from '../types';
import {
  InvalidScheduleError,
  ScheduleCancelledEvent,
  SchedulePausedEvent,
  ScheduleResumedEvent,
  type ScheduleTick,
  type ScheduledAgentRunInput,
  createAgentScheduler,
  isScheduledAgentRunInput,
} from '@lostgradient/operative';
import { KEYS, decode } from '@lostgradient/weft';
import {
  type PendingScheduleTransition,
  SCHEDULE_TRANSITION_KEY_PREFIX,
  type ScheduleTransitionKind,
  decodeScheduleTransition,
  scheduleTransitionKey,
  scheduleTransitionKeyPrefix,
  scheduleTransitionOperation,
} from '../schedule-transition-outbox';
import {
  captureRunWorkspaceAuthority,
  mayUseAutomationInput,
  recoverRunWorkspaceAuthority,
  validateRunWorkspaceAuthority,
} from '../run-authority.ts';
import { markEventSource } from '../event-source';
import { ownerFromPrincipal, ownerOrLocal } from '../owner-of-record';
import {
  parseWorkflowScheduleId,
  storedScheduleInput,
  workflowScheduleBinding,
} from '../workflow-schedule';
import {
  rejectReservedIdentifier,
  rejectUnopenableNewSessionIdentifier,
  replaceInputText,
} from '../run-request-validation';
import { resolveWorkspaceOwner } from '../http/workspace-principal.ts';
import { serializeUnknownError } from '../serialization';
import { startScheduleTick } from '../schedule-tick';
import { toScheduleSpec } from '../schedule-spec';
import { unopenableNewSessionIdentifierReason } from '../reserved-identifiers';

/** The callables schedule operations reads from elsewhere in `constructBureau`. */
export interface ScheduleOperationsPeers {
  /** The hook origin a run was started by, if any. */
  readonly hookOriginOfRun: (runId: string) => Promise<string | undefined>;
  /** The stored input of an agent schedule, if it has one. */
  readonly readScheduledAgentInput: (
    scheduleId: string,
  ) => Promise<ScheduledAgentRunInput | undefined>;
  /** The owner of a stored session, if it exists. */
  readonly sessionOwner: (sessionId: string) => Promise<string | undefined>;
}

/** Builds the schedule operations of one Bureau. Synchronous, and registers nothing. */
export function createScheduleOperations<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: ScheduleOperationsPeers,
) {
  const { workspace, runtimeServices, emitter, runtime, diagnose } = core;

  /**
   * Under a workspace Bureau a schedule may continue only a chat its own owner holds, so a session
   * that is another owner's, or that does not exist, is answered as not found. Creating and
   * updating a schedule share this check, because every fire of one that fails it is `unavailable`.
   */
  async function refuseScheduleSessionOfAnotherOwner(
    sessionId: string,
    owner: string,
  ): Promise<void> {
    if (workspace !== undefined && (await peers.sessionOwner(sessionId)) !== owner) {
      throw new BureauError('Session not found', 'NOT_FOUND');
    }
  }

  /**
   * Whether the owner may keep a schedule's recurring chat. A chat that is not made yet is theirs
   * to make, as the first fire of a schedule that Bureau named a chat for does; one that exists
   * must be theirs.
   */
  async function mayContinueScheduleSession(
    sessionId: string | undefined,
    owner: string,
  ): Promise<boolean> {
    if (sessionId === undefined) return true;
    const held = await peers.sessionOwner(sessionId);
    return held === undefined || held === owner;
  }

  async function createSchedule(
    definition: DurableScheduleDefinition,
    scheduleOptions?: CreateScheduleOptions,
    // COR-1879 — the plugin whose host API creates the schedule; its `schedule.created` names it.
    source?: string,
  ): Promise<import('@lostgradient/weft').ScheduleSummary | undefined> {
    definition = structuredClone(definition);
    // A chat Bureau names itself is unguessable and not yet made, so it is not another owner's to
    // refuse: the schedule's first fire makes it, owned by the schedule's owner.
    const allocatedChat = definition.continueChat === true;
    if (allocatedChat) {
      if (definition.sessionId !== undefined) {
        throw new BureauError('"continueChat" and "sessionId" cannot both be given', 'BAD_REQUEST');
      }
      definition.sessionId = runtimeServices.identifiers.next('session');
    }
    if (definition.sessionId !== undefined) {
      rejectReservedIdentifier('"sessionId"', definition.sessionId.trim());
      // A schedule's session is made by its first fire when none exists yet. Only `.` and `..` are
      // refused for one that does not, so any other id costs no read of the store.
      if (unopenableNewSessionIdentifierReason('"sessionId"', definition.sessionId.trim())) {
        const held = await runtime.sessionStore?.load(definition.sessionId.trim());
        rejectUnopenableNewSessionIdentifier(
          '"sessionId"',
          definition.sessionId.trim(),
          held !== undefined,
        );
      }
    }
    const owner = ownerFromPrincipal(definition.principal, toBadRequest);
    if (definition.sessionId !== undefined && !allocatedChat) {
      await refuseScheduleSessionOfAnotherOwner(definition.sessionId.trim(), owner);
    }
    const workspaceAuthority =
      workspace === undefined ? undefined : await captureRunWorkspaceAuthority(workspace, owner);
    if (workspace !== undefined && workspaceAuthority === undefined)
      throw new BureauError('Workspace authority unavailable.', 'CONFLICT');
    if (!runtime.durable) return undefined;
    // COR-1667 — resolve the name the way a fire does (`agentCatalog.find`, which includes file
    // agents), so a typo is refused now instead of as `missing-agent` at the first fire. An agent
    // that goes missing later still fails at fire time, unchanged.
    if (core.agentCatalog.find(definition.agentName) === undefined) {
      throw new UnknownScheduleAgentError(definition.agentName);
    }
    // Register a native weft schedule that fires the `agentRun` workflow on each
    // tick. The fire path is wired through `resolveRunServices`' scheduled-fire
    // branch (see runtime-composition.ts): each tick builds fresh run deps from
    // the ScheduledAgentRunInput, seeds the prompt, and runs the agent (#109).
    //
    // Definition validation (blank recurring session, overlap 'allow' + recurring
    // session) lives in `createAgentSchedule` — the single chokepoint every caller
    // (bureau, AgentScheduler, the scheduleSelf tool) routes through — so it cannot
    // be bypassed. We surface its `InvalidScheduleError` as a BAD_REQUEST (400).
    //
    // Passing this bureau's own `emitter` here (unlike `pauseSchedule`/
    // `resumeSchedule`/`cancelSchedule` below, which dispatch directly) forwards
    // `createAgentSchedule`'s `AgentScheduledEvent` (`schedule.created`, AB-298)
    // straight onto it, exactly once for the fresh registration this call makes —
    // no separate dispatch needed here.
    const scheduler = createAgentScheduler({
      engine: runtime.durable.engine,
      // COR-1879: the internal variant a plugin's host API uses marks what it forwards.
      emitter:
        source === undefined
          ? emitter
          : { dispatch: (event) => emitter.dispatch(markEventSource(event, source)) },
    });
    // COR-1952: a schedule a hook-started run creates records the hook before it exists, under an
    // id minted here, so no fire can run before its origin is readable.
    const hookOrigin =
      scheduleOptions?.createdByRun === undefined || core.scheduleHookOrigins === undefined
        ? undefined
        : await peers.hookOriginOfRun(scheduleOptions.createdByRun);
    const originId =
      hookOrigin === undefined ? undefined : runtimeServices.identifiers.next('schedule');
    if (originId !== undefined && hookOrigin !== undefined) {
      await core.scheduleHookOrigins!.recordSchedule(originId, hookOrigin);
    }
    let handle;
    try {
      handle = await scheduler.schedule(definition.agentName, {
        ...(originId === undefined ? {} : { id: originId }),
        spec: toScheduleSpec(definition.spec),
        input: definition.input,
        ...(definition.description !== undefined ? { description: definition.description } : {}),
        ...(definition.sessionId !== undefined ? { session: definition.sessionId } : {}),
        ...(definition.overlap !== undefined ? { overlap: definition.overlap } : {}),
        ...(definition.timeZone !== undefined ? { timeZone: definition.timeZone } : {}),
        principal: owner,
        ...(workspaceAuthority === undefined ? {} : { workspaceAuthority }),
      });
    } catch (error) {
      // Nothing was registered under the id, so its origin names no schedule.
      if (originId !== undefined) await core.scheduleHookOrigins?.clearSchedule(originId);
      if (error instanceof InvalidScheduleError) {
        toBadRequest(error.message);
      }
      throw error;
    }
    // The schedule is already registered at this point — a `describe()`
    // rejection here means only its locator (summary) is unavailable, not
    // that registration failed. Wrap it in a typed error naming the
    // `scheduleId` instead of letting `AgentScheduleHandle.describe()`'s bare
    // `Error('Schedule … no longer exists.')` propagate untyped.
    try {
      return await handle.describe();
    } catch (cause) {
      throw new ScheduleLocatorUnavailableError(handle.id, { cause });
    }
  }

  /**
   * COR-2009 — starts the schedule tick that records what the scheduler did, naming the schedule by
   * its description as it is now. Best effort: a tick that cannot be recorded is diagnosed and never
   * holds up the fire or the notice it records.
   */
  async function recordScheduleTick(
    scheduleId: string,
    tickOf: (scheduleName: string | null) => ScheduleTick,
  ): Promise<void> {
    const engine = runtime.durable?.engine;
    if (engine === undefined) return;
    try {
      const schedule = await engine.getSchedule(scheduleId);
      await startScheduleTick(engine, tickOf(schedule?.description ?? null));
    } catch (error) {
      diagnose({
        level: 'warn',
        scope: 'schedules',
        message: `[bureau] Could not record the schedule tick of schedule "${scheduleId}":`,
        cause: error,
      });
    }
  }

  async function getSchedule(
    scheduleId: string,
  ): Promise<import('@lostgradient/weft').ScheduleSummary | null | undefined> {
    if (!runtime.durable) return undefined;
    return runtime.durable.engine.getSchedule(scheduleId);
  }

  async function listSchedules(
    filter?: import('@lostgradient/weft').ScheduleFilter,
  ): Promise<
    | import('@lostgradient/weft').PaginatedResult<import('@lostgradient/weft').ScheduleSummary>
    | undefined
  > {
    if (!runtime.durable) return undefined;
    return runtime.durable.engine.listSchedules(filter);
  }

  /**
   * COR-1527 — a workflow file owns its schedule, so a write to it through the schedule methods is
   * answered as if the schedule did not exist; the workflow's own operations are the only way to
   * change it.
   */
  function refuseWorkflowSchedule(scheduleId: string): void {
    if (core.workflowRuntime !== undefined && parseWorkflowScheduleId(scheduleId) !== undefined) {
      throw new BureauError(`Schedule "${scheduleId}" does not exist`, 'NOT_FOUND');
    }
  }

  async function reassignSchedule(
    scheduleId: string,
    request: {
      readonly administrator: string;
      readonly targetOwner: string;
      readonly expectedRevision: number;
    },
  ): Promise<true | undefined> {
    const { administrator, targetOwner, expectedRevision } = request;
    if (workspace === undefined)
      throw new BureauError('Workspace authority unavailable.', 'CONFLICT');
    const durable = runtime.durable;
    if (durable === undefined) return undefined;
    const snapshot = await durable.engine.getSchedule(scheduleId);
    if (snapshot?.revision !== expectedRevision)
      throw new BureauError('Schedule revision changed.', 'CONFLICT');
    const input = await storedScheduleInput(durable.engine, scheduleId);
    if (
      typeof input !== 'object' ||
      input === null ||
      Array.isArray(input) ||
      (!isScheduledAgentRunInput(input) &&
        (parseWorkflowScheduleId(scheduleId) === undefined ||
          Reflect.get(input, 'kind') !== 'schedule'))
    )
      throw new BureauError('Schedule not found.', 'NOT_FOUND');
    const previous = workflowScheduleBinding(input).workspaceAuthority;
    if (previous === undefined || previous.workspaceId !== workspace.workspaceId)
      throw new BureauError('Workspace authority unavailable.', 'CONFLICT');
    const target = await resolveWorkspaceOwner(workspace, targetOwner);
    const admin = await resolveWorkspaceOwner(workspace, administrator);
    if (
      admin === undefined ||
      !admin.capabilities.includes('workspace:manage') ||
      target === undefined ||
      target.actorKind === 'service'
    )
      throw new BureauError('Workspace authority unavailable.', 'CONFLICT');
    const next = {
      version: 1 as const,
      workspaceId: target.workspaceId,
      actorId: target.actorId,
      authorizingOwner: target.owner,
      membershipRevision: target.membershipRevision,
    };
    const transition: PendingScheduleTransition = {
      kind: 'schedule.paused',
      scheduleId,
      committedAtMs: runtimeServices.clock.now(),
      reassignment: {
        workspaceId: workspace.workspaceId,
        previousActor: previous.actorId,
        nextActor: target.actorId,
        administrator: admin.actorId,
        previousRevision: expectedRevision,
        nextRevision: expectedRevision + 1,
      },
    };
    const key = scheduleTransitionKey(
      transition,
      runtimeServices.identifiers.next('schedule-transition'),
    );
    await durable.engine.replaceScheduleInput(
      scheduleId,
      { ...input, workspaceAuthority: next, authorityHold: 'reassigned' },
      {
        expectedRevision,
        additionalOperations: [scheduleTransitionOperation(key, transition)],
      },
    );
    try {
      await recordPendingScheduleTransitions(scheduleTransitionKeyPrefix(scheduleId));
    } catch {
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: 'Schedule reassignment audit remains pending for maintenance.',
      });
    }
    return true;
  }

  async function pauseInvalidSchedule(scheduleId: string): Promise<void> {
    if (workspace === undefined || runtime.durable === undefined) return;
    const snapshot = await runtime.durable.engine.getSchedule(scheduleId);
    if (snapshot?.status !== 'active') return;
    const input = await storedScheduleInput(runtime.durable.engine, scheduleId);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return;
    if (!isScheduledAgentRunInput(input) && parseWorkflowScheduleId(scheduleId) === undefined) {
      if (snapshot.workflowType === 'agentRun')
        await runtime.durable.engine.pauseSchedule(scheduleId, {
          expectedRevision: snapshot.revision,
        });
      return;
    }
    let binding;
    try {
      binding = workflowScheduleBinding(input);
    } catch {
      await runtime.durable.engine.pauseSchedule(scheduleId, {
        expectedRevision: snapshot.revision,
      });
      return;
    }
    const authority = await recoverRunWorkspaceAuthority(
      workspace,
      binding.workspaceAuthority,
      isScheduledAgentRunInput(input) ? input.principal : 'anonymous:local',
    );
    const usableInput =
      !isScheduledAgentRunInput(input) ||
      (authority !== undefined &&
        (await mayContinueScheduleSession(input.sessionId, authority.authorizingOwner)) &&
        (await mayUseAutomationInput(
          input.input,
          runtime.mediaOptionsFor(authority.authorizingOwner, 'session').contentSourceResolver,
        )));
    if (authority !== undefined && binding.authorityHold === undefined && usableInput) {
      if (binding.workspaceAuthority === undefined)
        await runtime.durable.engine.replaceScheduleInput(
          scheduleId,
          { ...input, workspaceAuthority: authority },
          { expectedRevision: snapshot.revision, status: 'active' },
        );
      return;
    }
    await runtime.durable.engine.replaceScheduleInput(
      scheduleId,
      { ...input, authorityHold: binding.authorityHold ?? 'revoked' },
      { expectedRevision: snapshot.revision },
    );
  }

  async function pauseInvalidSchedules(): Promise<void> {
    if (workspace === undefined || runtime.durable === undefined) return;
    let offset = 0;
    for (;;) {
      const page = await runtime.durable.engine.listSchedules({ offset, limit: 100 });
      for (const schedule of page.items) await pauseInvalidSchedule(schedule.id);
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) break;
    }
  }

  async function pauseSchedule(
    scheduleId: string,
    guard?: ScheduleRevisionGuard,
  ): Promise<true | undefined> {
    const durable = runtime.durable;
    if (!durable) return undefined;
    refuseWorkflowSchedule(scheduleId);
    await transitionSchedule('schedule.paused', scheduleId, guard, (transition) =>
      durable.engine.pauseSchedule(scheduleId, transition),
    );
    return true;
  }

  async function resumeSchedule(
    scheduleId: string,
    guard?: ScheduleRevisionGuard,
  ): Promise<true | undefined> {
    const durable = runtime.durable;
    if (!durable) return undefined;
    refuseWorkflowSchedule(scheduleId);
    if (workspace === undefined) {
      await transitionSchedule('schedule.resumed', scheduleId, guard, (transition) =>
        durable.engine.resumeSchedule(scheduleId, transition),
      );
    } else {
      const snapshot = await durable.engine.getSchedule(scheduleId);
      const input = await peers.readScheduledAgentInput(scheduleId);
      const authority = await validateRunWorkspaceAuthority(workspace, input?.workspaceAuthority);
      if (
        snapshot === null ||
        input === undefined ||
        authority === undefined ||
        !(await mayContinueScheduleSession(input.sessionId, authority.authorizingOwner)) ||
        !(await mayUseAutomationInput(
          input.input,
          runtime.mediaOptionsFor(authority.authorizingOwner, 'session').contentSourceResolver,
        ))
      ) {
        throw new BureauError('Workspace authority unavailable.', 'CONFLICT');
      }
      const { authorityHold: _hold, ...resumed } = input;
      await transitionSchedule('schedule.resumed', scheduleId, guard, (transition) =>
        durable.engine.replaceScheduleInput(scheduleId, resumed, {
          ...transition,
          expectedRevision: transition.expectedRevision ?? snapshot.revision,
          status: 'active',
        }),
      );
    }
    return true;
  }

  async function cancelSchedule(
    scheduleId: string,
    guard?: ScheduleRevisionGuard,
  ): Promise<true | undefined> {
    const durable = runtime.durable;
    if (!durable) return undefined;
    refuseWorkflowSchedule(scheduleId);
    await transitionSchedule('schedule.cancelled', scheduleId, guard, (transition) =>
      durable.engine.cancelSchedule(scheduleId, transition),
    );
    return true;
  }

  /**
   * COR-194 — commits a schedule transition with its pending record in the same storage write
   * (`schedule-transition-outbox.ts`), then records it. A transition Weft finds nothing to do for
   * (pausing a schedule that is not active, resuming an active one) writes nothing, the pending
   * record included, so it is neither recorded nor dispatched. A record that cannot be written
   * now stays pending for the boot pass, and the transition itself still succeeds: it committed.
   */
  async function transitionSchedule(
    kind: ScheduleTransitionKind,
    scheduleId: string,
    guard: ScheduleRevisionGuard | undefined,
    apply: (transition: import('@lostgradient/weft').ScheduleTransitionOptions) => Promise<void>,
  ): Promise<void> {
    const transition: PendingScheduleTransition = {
      kind,
      scheduleId,
      committedAtMs: runtimeServices.clock.now(),
    };
    const key = scheduleTransitionKey(
      transition,
      runtimeServices.identifiers.next('schedule-transition'),
    );
    await apply({
      ...scheduleTransitionOptions(guard),
      additionalOperations: [scheduleTransitionOperation(key, transition)],
    });
    // Everything after the commit is a failure to record, never a failure of the transition. The
    // schedule's whole pending queue is drained, so this transition is recorded behind any earlier
    // one still pending; when Weft wrote nothing, the queue holds nothing of this call's.
    try {
      await recordPendingScheduleTransitions(scheduleTransitionKeyPrefix(scheduleId));
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: `[bureau] Could not record ${kind} for schedule "${scheduleId}"; it stays pending for the next drain: ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
  }

  /**
   * COR-194 — records one pending schedule transition in durable history and the audit trail under
   * its own key as the dedupe key, removes the pending record, then dispatches the live event. A
   * write that fails rejects before the pending record is removed, so the transition is recorded
   * at a later attempt and, through the dedupe key, only once.
   */
  async function recordScheduleTransition(
    key: string,
    transition: PendingScheduleTransition,
  ): Promise<void> {
    // A scan's snapshot can be stale: another process's drain may have recorded and removed the
    // key since.
    if ((await runtime.durable!.engine.storage.get(key)) === null) return;
    const { kind, scheduleId, committedAtMs } = transition;
    const recordKind = transition.reassignment === undefined ? kind : 'schedule.reassigned';
    const detail = { scheduleId, ...transition.reassignment };
    await core.eventHistoryInstance?.record(
      { kind: 'schedule', id: scheduleId },
      recordKind,
      detail,
      {
        dedupeKey: key,
        emittedAtMs: committedAtMs,
      },
    );
    await core.auditTrailInstance?.record({
      runId: `${AUDIT_SCHEDULE_OWNER_PREFIX}${scheduleId}`,
      type: recordKind,
      detail,
      timestampMs: committedAtMs,
      dedupeKey: key,
    });
    await runtime.durable!.engine.storage.delete(key);
    const record = { dedupeKey: key, committedAtMs };
    try {
      emitter.dispatch(
        kind === 'schedule.paused'
          ? new SchedulePausedEvent(scheduleId, record)
          : kind === 'schedule.resumed'
            ? new ScheduleResumedEvent(scheduleId, record)
            : new ScheduleCancelledEvent(scheduleId, record),
      );
    } catch (error) {
      // A `bureau.toObservable()` subscriber has no isolation of its own (see `drainOutboxEntry`).
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: `[bureau] A bureau.toObservable() subscriber threw on ${kind} for schedule "${scheduleId}":`,
        cause: error,
      });
    }
  }

  /**
   * COR-194 — every drain this process runs, chained, so no two overlap: two drains of the same
   * schedule at once could record its transitions out of order, or one twice.
   */
  let scheduleTransitionDrains: Promise<void> = Promise.resolve();

  /**
   * COR-194 — records every schedule transition still pending under `prefix` (every schedule's,
   * or one schedule's for the live drain): one a process committed and did not live to record, one
   * whose record failed after its commit, or one just committed. Each schedule's transitions are
   * recorded in the order they committed, and a failure defers the rest of that schedule's to a
   * later pass, so its history is never written out of order. A record this build cannot read is
   * reported and kept, since a build that can may read it later.
   */
  function recordPendingScheduleTransitions(
    prefix: string = SCHEDULE_TRANSITION_KEY_PREFIX,
  ): Promise<void> {
    const drain = scheduleTransitionDrains.then(() => drainScheduleTransitions(prefix));
    // The chain carries on past a failed drain; the caller still sees the failure.
    scheduleTransitionDrains = drain.catch(() => undefined);
    return drain;
  }

  async function drainScheduleTransitions(prefix: string): Promise<void> {
    const durable = runtime.durable;
    if (!durable) return;
    const pending: Array<[string, Uint8Array]> = [];
    for await (const entry of durable.engine.storage.scan(prefix)) {
      pending.push(entry);
    }
    const deferredSchedules = new Set<string>();
    for (const [key, bytes] of pending) {
      const scheduleSegment = key.slice(SCHEDULE_TRANSITION_KEY_PREFIX.length).split(':')[0];
      if (deferredSchedules.has(scheduleSegment ?? '')) continue;
      const transition = decodeScheduleTransition(bytes);
      if (transition === undefined) {
        deferredSchedules.add(scheduleSegment ?? '');
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Left pending schedule transition "${key}" in place: this build cannot read it.`,
        });
        continue;
      }
      try {
        await recordScheduleTransition(key, transition);
      } catch (error) {
        deferredSchedules.add(scheduleSegment ?? '');
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Could not record pending ${transition.kind} for schedule "${transition.scheduleId}"; leaving it and the schedule's later transitions for the next drain: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
    }
  }

  /** What Weft's pause, resume, and cancel take for a guard: the revision, or nothing at all. */
  function scheduleTransitionOptions(
    guard: ScheduleRevisionGuard | undefined,
  ): { expectedRevision: number } | undefined {
    return guard?.expectedRevision === undefined
      ? undefined
      : { expectedRevision: guard.expectedRevision };
  }

  async function skipNextSchedule(
    scheduleId: string,
    guard?: ScheduleRevisionGuard,
    occurrence?: number,
  ): Promise<true | undefined> {
    if (!runtime.durable) return undefined;
    refuseWorkflowSchedule(scheduleId);
    await runtime.durable.engine.skipNextScheduleOccurrence(scheduleId, {
      ...scheduleTransitionOptions(guard),
      ...(occurrence === undefined ? {} : { occurrence }),
    });
    return true;
  }

  async function unskipSchedule(
    scheduleId: string,
    occurrence: number,
    guard?: ScheduleRevisionGuard,
  ): Promise<true | undefined> {
    if (!runtime.durable) return undefined;
    refuseWorkflowSchedule(scheduleId);
    await runtime.durable.engine.unskipScheduleOccurrence(scheduleId, {
      ...scheduleTransitionOptions(guard),
      occurrence,
    });
    return true;
  }

  async function runScheduleNow(
    scheduleId: string,
  ): Promise<import('@lostgradient/weft').ScheduleTriggerResult | undefined> {
    if (!runtime.durable) return undefined;
    refuseWorkflowSchedule(scheduleId);
    return runtime.durable.engine.triggerSchedule(scheduleId);
  }

  async function listScheduleMissed(
    scheduleId: string,
    read?: { readonly limit?: number | undefined },
  ): Promise<import('@lostgradient/weft').ScheduleMissedFire[] | null | undefined> {
    if (!runtime.durable) return undefined;
    return runtime.durable.engine.listScheduleMissedFires(
      scheduleId,
      read?.limit === undefined ? undefined : { limit: read.limit },
    );
  }

  async function updateSchedule(
    scheduleId: string,
    update: DurableScheduleUpdate,
    guard?: ScheduleRevisionGuard,
  ): Promise<true | undefined> {
    if (!runtime.durable) return undefined;
    refuseWorkflowSchedule(scheduleId);
    if (update.overlap !== undefined && update.overlap !== 'skip' && update.overlap !== 'allow') {
      throw new BureauError(
        `overlap policy '${String(update.overlap)}' is not supported by Bureau; only 'skip' and 'allow' are offered`,
        'BAD_REQUEST',
      );
    }
    const engine = runtime.durable.engine;
    if (update.continueChat === true && update.sessionId !== undefined) {
      throw new BureauError('"continueChat" and "sessionId" cannot both be given', 'BAD_REQUEST');
    }
    const changesRun =
      update.agentName !== undefined ||
      update.input !== undefined ||
      update.sessionId !== undefined ||
      update.continueChat === true;
    // The stored state is read for what an edit of the run needs (its input, the overlap and the
    // revision it was written at), and for the check that a recurring session is never combined
    // with overlapping fires.
    const bytes =
      changesRun || update.overlap === 'allow'
        ? await engine.storage.get(KEYS.schedule(scheduleId))
        : null;
    const stored: unknown = bytes ? decode(bytes) : undefined;
    const storedRecord =
      typeof stored === 'object' && stored !== null
        ? (stored as { input?: unknown; overlap?: unknown; revision?: unknown })
        : undefined;
    const storedInput = isScheduledAgentRunInput(storedRecord?.input)
      ? storedRecord.input
      : undefined;
    if (changesRun && storedInput === undefined) {
      throw new BureauError(`Schedule "${scheduleId}" does not exist`, 'NOT_FOUND');
    }
    const nextOverlap = update.overlap ?? storedRecord?.overlap;
    // A chat Bureau names itself is unguessable and not yet made (see `createSchedule`).
    const allocatedChat =
      update.continueChat === true ? runtimeServices.identifiers.next('session') : undefined;
    const nextSession =
      allocatedChat ??
      (update.sessionId === undefined ? storedInput?.sessionId : (update.sessionId ?? undefined));
    if (update.sessionId !== undefined && update.sessionId !== null) {
      const sessionId = update.sessionId.trim();
      rejectReservedIdentifier('"sessionId"', sessionId);
      if (unopenableNewSessionIdentifierReason('"sessionId"', sessionId)) {
        const held = await runtime.sessionStore?.load(sessionId);
        rejectUnopenableNewSessionIdentifier('"sessionId"', sessionId, held !== undefined);
      }
      // `changesRun` is true here, so the stored input was read and its principal is the owner.
      await refuseScheduleSessionOfAnotherOwner(sessionId, ownerOrLocal(storedInput?.principal));
    }
    // COR-323: a fire runs as its named agent and refuses a chat another agent began, so an
    // update that would leave the schedule's agent and its chat apart is refused now, not as an
    // `unavailable` at every fire after it.
    const nextAgent = update.agentName ?? storedInput?.agentName;
    if (allocatedChat === undefined && nextSession !== undefined && nextAgent !== undefined) {
      const held = await runtime.sessionStore?.load(nextSession);
      if (held !== undefined && held.agentName !== nextAgent) {
        throw new BureauError(
          `Schedule "${scheduleId}" would run agent "${nextAgent}" in a chat that belongs to agent "${held.agentName}". Start a new chat with the change, or keep the agent.`,
          'BAD_REQUEST',
        );
      }
    }
    if (nextOverlap === 'allow' && nextSession !== undefined) {
      // A recurring session is sequential: overlapping fires would interleave its turns, which is
      // why creating such a schedule refuses `allow` too.
      throw new BureauError(
        "overlap 'allow' is incompatible with a recurring session (fires must serialize)",
        'BAD_REQUEST',
      );
    }
    if (update.agentName !== undefined && core.agentCatalog.find(update.agentName) === undefined) {
      throw new UnknownScheduleAgentError(update.agentName);
    }
    if (update.input !== undefined && update.input.trim() === '') {
      throw new BureauError('"input" must be a non-empty string', 'BAD_REQUEST');
    }
    let nextInput: ScheduledAgentRunInput | undefined;
    if (changesRun && storedInput !== undefined) {
      const { sessionId: _kept, ...rest } = storedInput;
      nextInput = {
        ...rest,
        ...(update.agentName === undefined ? {} : { agentName: update.agentName }),
        ...(update.input === undefined
          ? {}
          : { input: replaceInputText(storedInput.input, update.input) }),
        ...(nextSession === undefined ? {} : { sessionId: nextSession }),
      };
    }
    // Whatever was read decided what this update may do (the input it rebuilds, and whether
    // `overlap` and a recurring chat may be combined), so the write is fenced to the revision that
    // was read when the caller named none: a change made since is refused, not overwritten. An
    // update of the overlap alone is fenced as well, or it could land on a chat another update gave
    // the schedule since, which leaves the combination that is refused above.
    const expectedRevision =
      guard?.expectedRevision ??
      (bytes !== null && typeof storedRecord?.revision === 'number'
        ? storedRecord.revision
        : undefined);
    await engine.updateSchedule(scheduleId, toScheduleSpec(update.spec), {
      ...(update.description === undefined ? {} : { description: update.description }),
      ...(update.overlap === undefined ? {} : { overlap: update.overlap }),
      ...(update.timeZone === undefined ? {} : { timeZone: update.timeZone }),
      ...(nextInput === undefined ? {} : { input: nextInput }),
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
    return true;
  }

  return {
    createSchedule,
    recordScheduleTick,
    getSchedule,
    listSchedules,
    reassignSchedule,
    pauseInvalidSchedule,
    pauseInvalidSchedules,
    pauseSchedule,
    resumeSchedule,
    cancelSchedule,
    recordPendingScheduleTransitions,
    skipNextSchedule,
    unskipSchedule,
    runScheduleNow,
    listScheduleMissed,
    updateSchedule,
  };
}
