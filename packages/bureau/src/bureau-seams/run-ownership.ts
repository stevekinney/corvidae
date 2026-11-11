/**
 * Run ownership (COR-2376 slice S12): the one reader of what a held run is attributed to, the
 * owner of record of a run, a schedule, a session and any other owned resource, and the readers of
 * what a schedule's recorded input says. Built by `constructBureau` and reached only through
 * `createBureau`; the event history, review records, run operations and schedule operations ask
 * it who owns a thing. `runOwner` and `ownerOf` are also read above the seam block, inside
 * callbacks, which is lazy.
 */
import {
  AUDIT_AGENT_OWNER_PREFIX,
  AUDIT_HOOK_OWNER_PREFIX,
  AUDIT_HOST_OWNER_ID,
  AUDIT_SCHEDULE_OWNER_PREFIX,
  AUDIT_SESSION_OWNER_PREFIX,
  AUDIT_SKILL_SOURCE_OWNER_PREFIX,
  AUDIT_TOOL_SOURCE_OWNER_PREFIX,
  AUDIT_WORKER_DEPLOYMENT_OWNER_PREFIX,
  AUDIT_WORKFLOW_OWNER_PREFIX,
} from '../audit-trail';
import type { AgentDefinitions } from '../agent-catalog';
import type { BureauCore } from './core';
import { KEYS, decode } from '@lostgradient/weft';
import type { OwnedResource } from '../bureau-types/facade';
import type { PendingReview, ReviewResolutionFields } from '../bureau-types/reviews';
import type { RunAttribution } from '../serialization';
import { type ScheduledAgentRunInput, isScheduledAgentRunInput } from '@lostgradient/operative';
import type { WorkflowScheduleBlocker } from '../workflow-runtime';
import { isTaskOrigin } from '../task-origin';
import { ownerOrLocal } from '../owner-of-record';
import { resolvePersistedRunOwningPrincipal, resolveSessionOwner } from '../session-authority';
import { scheduleInputPreview } from '../schedule-input-preview';

/** The callables run ownership reads from elsewhere in `constructBureau`. */
export interface RunOwnershipPeers {
  /** Reads one review by id. */
  readonly getReview: (id: string) => Promise<(PendingReview & ReviewResolutionFields) | undefined>;
}

/** Builds the run ownership of one Bureau. Synchronous, and registers nothing. */
export function createRunOwnership<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: RunOwnershipPeers,
) {
  const { store, runtime, runAttribution } = core;

  /**
   * COR-1588 — the one reader of what a held run is attributed to: its recorded attribution,
   * with a `principal` it lacks filled from the handle's liveness owner. A live `bureau.run()`
   * dispatch that is not durable seeds no attribution, but its handle's liveness snapshot carries
   * the principal it was given. `runOwner` and every serialized `principal` (`RunSummary`,
   * `RunDetail`) read it here, so the owner the AG-UI mount authorizes on is the owner the run
   * reports.
   */
  function attributionOf(runId: string): RunAttribution | undefined {
    const recorded = runAttribution.get(runId);
    if (recorded?.principal !== undefined) return recorded;
    return recorded;
  }

  /**
   * COR-718 — the owner of record of a run: where it already lives
   * (`runAttribution`, rehydrated from the session's `lastRunOwningPrincipals`
   * after a restart), or a child run's own record. `undefined` for an id that
   * names no run this Bureau knows.
   */
  async function runOwner(runId: string): Promise<string | undefined> {
    if (runAttribution.get(runId) !== undefined || store.getRun(runId) !== undefined) {
      return ownerOrLocal(attributionOf(runId)?.principal);
    }
    const child = await core.childTopologyStore.get(runId);
    if (child !== undefined) return ownerOrLocal(child.principal);
    // A schedule fire's attribution is released when the fire settles. Its owner is
    // then the one its workflow was started with, which is the schedule's: the
    // engine keeps the fire's `ScheduledAgentRunInput`, `principal` included.
    if (!runtime.durable) return undefined;
    const fire = await runtime.durable.engine.get(runId);
    // COR-1527: an instance of a workflow file belongs to the deployment's owner of record, as the
    // file does.
    if (
      fire !== null &&
      fire !== undefined &&
      core.workflowRuntime !== undefined &&
      (await core.workflowRuntime.isWorkflowType(fire.type))
    ) {
      const input = fire.input;
      const origin =
        typeof input === 'object' && input !== null && 'origin' in input ? input.origin : undefined;
      if (isTaskOrigin(origin) && origin.kind === 'person') return origin.principal;
      return core.workflowRuntime.workflows.owner;
    }
    if (fire !== null && isScheduledAgentRunInput(fire.input)) {
      return ownerOrLocal(fire.input.principal);
    }
    // COR-1580: a session run another process created after this one booted. Its owner is the one
    // its session recorded for it, found through the session its durable input names.
    const sessionRunOwner = await persistedSessionRunOwner(runId, fire?.input);
    if (sessionRunOwner !== undefined) return sessionRunOwner;
    // COR-1579: a `bureau.run()` run another process holds is in none of the maps above, but its
    // durable recovery record names who started it.
    const catalog = await runtime.classifyCatalogRecoveredRun(runId);
    return catalog.attribution === undefined
      ? undefined
      : ownerOrLocal(catalog.attribution.principal);
  }

  /** The session a durable run's input names, as a session run's `createRun` recorded it. */
  function durableInputSessionId(input: unknown): string | undefined {
    const sessionId =
      typeof input === 'object' && input !== null
        ? (input as { sessionId?: unknown }).sessionId
        : undefined;
    return typeof sessionId === 'string' ? sessionId : undefined;
  }

  /**
   * COR-1580 — the owner a session recorded for one of its runs (`lastRunOwningPrincipals`), when
   * the run's durable input names that session; `undefined` when either is missing.
   */
  async function persistedSessionRunOwner(
    runId: string,
    input: unknown,
  ): Promise<string | undefined> {
    const sessionId = durableInputSessionId(input);
    if (sessionId === undefined || !runtime.sessionStore) return undefined;
    const session = await runtime.sessionStore.load(sessionId);
    if (session === undefined) return undefined;
    const principal = resolvePersistedRunOwningPrincipal(session.metadata, runId);
    if (principal === undefined) return undefined;
    // A deleted run keeps its session entry (so its `run.removed` event stays owned), but it has
    // no owner to authorize against: it fails closed as AB-313 decided, wherever it was deleted.
    const removed = await core.eventHistoryInstance?.latestDeletionMarker({
      kind: 'run',
      id: runId,
    });
    return removed === undefined ? ownerOrLocal(principal) : undefined;
  }

  /** COR-718 — the owner a schedule recorded in its `ScheduledAgentRunInput.principal`. */
  async function scheduleOwner(scheduleId: string): Promise<string | undefined> {
    if (!runtime.durable) return undefined;
    // COR-1527: a workflow file's schedule belongs to the deployment's owner of record.
    if (
      core.workflowRuntime !== undefined &&
      (await core.workflowRuntime.scheduleExists(scheduleId))
    ) {
      return core.workflowRuntime.workflows.owner;
    }
    const bytes = await runtime.durable.engine.storage.get(KEYS.schedule(scheduleId));
    if (!bytes) return undefined;
    const state: unknown = decode(bytes);
    const input =
      typeof state === 'object' && state !== null
        ? (state as { input?: unknown }).input
        : undefined;
    // Only an agent schedule has an owner; the local default applies to one that
    // names no principal, never to some other workflow's schedule on the same engine.
    return isScheduledAgentRunInput(input) ? ownerOrLocal(input.principal) : undefined;
  }

  /**
   * The stored input of an agent schedule, or `undefined` when there is no such schedule, when it
   * is a workflow file's (which runs no agent of its own), or when no durable engine is composed.
   */
  async function readScheduledAgentInput(
    scheduleId: string,
  ): Promise<ScheduledAgentRunInput | undefined> {
    if (!runtime.durable) return undefined;
    if (
      core.workflowRuntime !== undefined &&
      (await core.workflowRuntime.scheduleExists(scheduleId))
    ) {
      return undefined;
    }
    const bytes = await runtime.durable.engine.storage.get(KEYS.schedule(scheduleId));
    if (!bytes) return undefined;
    const state: unknown = decode(bytes);
    const input =
      typeof state === 'object' && state !== null
        ? (state as { input?: unknown }).input
        : undefined;
    return isScheduledAgentRunInput(input) ? input : undefined;
  }

  /**
   * The agent an agent schedule runs, read from the stored input beside the owner. Only the name
   * leaves here: the input's text is {@link getScheduleInputPreview}'s, and its session stays in
   * storage. A workflow file's schedule runs no agent of its own, so it has none.
   */
  async function getScheduleAgentName(scheduleId: string): Promise<string | undefined> {
    const stored = await readScheduledAgentInput(scheduleId);
    return stored?.agentName;
  }

  /**
   * The start of the text an agent schedule sends each fire, at most 500 characters and ending in
   * `…` when it was cut, so a schedule can be told by what it says (see
   * {@link scheduleInputPreview}); an input of media alone has none, and its schedule has no
   * preview.
   */
  /** COR-2009 — why a workflow file's schedule won't start: its file stopped parsing. */
  async function getScheduleBlocker(
    scheduleId: string,
  ): Promise<WorkflowScheduleBlocker | undefined> {
    return core.workflowRuntime?.scheduleBlocker(scheduleId);
  }

  async function getScheduleInputPreview(scheduleId: string): Promise<string | undefined> {
    const stored = await readScheduledAgentInput(scheduleId);
    if (stored === undefined) return undefined;
    return scheduleInputPreview(stored.input);
  }

  /** Whether every fire of an agent schedule continues one session; only the boolean leaves here. */
  async function getScheduleContinuesChat(scheduleId: string): Promise<boolean | undefined> {
    const stored = await readScheduledAgentInput(scheduleId);
    if (stored === undefined) return undefined;
    return stored.sessionId !== undefined;
  }

  async function sessionOwner(sessionId: string): Promise<string | undefined> {
    const session = await runtime.sessionStore?.load(sessionId);
    return session === undefined ? undefined : resolveSessionOwner(session.metadata);
  }

  async function ownerOf(resource: OwnedResource): Promise<string | undefined> {
    switch (resource.kind) {
      case 'run':
        return runOwner(resource.id);
      case 'session':
        return sessionOwner(resource.id);
      case 'goal': {
        const goal = await core.goalsComposition.goals.get(resource.id);
        return goal === undefined ? undefined : ownerOrLocal(goal.principal);
      }
      case 'schedule':
        return scheduleOwner(resource.id);
      case 'review': {
        const review = await peers.getReview(resource.id);
        return review === undefined ? undefined : runOwner(review.runId);
      }
      case 'audit': {
        const { runId, detail } = resource;
        if (runId.startsWith(AUDIT_SCHEDULE_OWNER_PREFIX)) {
          return scheduleOwner(runId.slice(AUDIT_SCHEDULE_OWNER_PREFIX.length));
        }
        if (runId === AUDIT_HOST_OWNER_ID) {
          // COR-2009 — the host has no owner field: its own records (`host.started`) belong to the
          // deployment's owner, so the owner's audit log lists "Server started".
          return ownerOrLocal(undefined);
        }
        if (runId.startsWith(AUDIT_AGENT_OWNER_PREFIX)) {
          // COR-1526 — an agent file has no owner field: it belongs to the deployment's owner.
          return ownerOrLocal(undefined);
        }
        if (runId.startsWith(AUDIT_WORKER_DEPLOYMENT_OWNER_PREFIX)) {
          // COR-1813 — a worker deployment has no owner field: it belongs to the deployment's owner.
          return ownerOrLocal(undefined);
        }
        if (runId.startsWith(AUDIT_SKILL_SOURCE_OWNER_PREFIX)) {
          // COR-1818 — a skill source has no owner field: the owner who changed its trust is
          // recorded on the entry, and a record without one belongs to the deployment's owner.
          const recorded =
            typeof detail === 'object' && detail !== null
              ? (detail as { owner?: unknown }).owner
              : undefined;
          return typeof recorded === 'string' ? recorded : ownerOrLocal(undefined);
        }
        if (runId.startsWith(AUDIT_TOOL_SOURCE_OWNER_PREFIX)) {
          // COR-1930 — a saved tool source has no owner field: the owner who changed it is
          // recorded on the entry, and a record without one belongs to the deployment's owner.
          const recorded =
            typeof detail === 'object' && detail !== null
              ? (detail as { owner?: unknown }).owner
              : undefined;
          return typeof recorded === 'string' ? recorded : ownerOrLocal(undefined);
        }
        if (runId.startsWith(AUDIT_WORKFLOW_OWNER_PREFIX)) {
          // COR-1529 — a workflow file has no owner field: it belongs to the deployment's owner.
          return ownerOrLocal(undefined);
        }
        if (runId.startsWith(AUDIT_HOOK_OWNER_PREFIX)) {
          // COR-1939 — read from the entry, never from the hook, which may be gone.
          const recorded =
            typeof detail === 'object' && detail !== null
              ? (detail as { owner?: unknown }).owner
              : undefined;
          return typeof recorded === 'string' ? recorded : undefined;
        }
        if (runId.startsWith(AUDIT_SESSION_OWNER_PREFIX)) {
          // Read from the entry, never from the session: it may be gone, or
          // recreated under another owner since the deletion.
          const recorded =
            typeof detail === 'object' && detail !== null
              ? (detail as { owner?: unknown }).owner
              : undefined;
          return typeof recorded === 'string' ? recorded : undefined;
        }
        return runOwner(runId);
      }
    }
  }

  return {
    attributionOf,
    runOwner,
    durableInputSessionId,
    scheduleOwner,
    readScheduledAgentInput,
    getScheduleAgentName,
    getScheduleBlocker,
    getScheduleInputPreview,
    getScheduleContinuesChat,
    sessionOwner,
    ownerOf,
  };
}
