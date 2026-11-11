/**
 * Session forks (COR-2376 slice S6): submit a steering command, fork a session, and read the steering
 * state and the context window of a session. Built by `constructBureau` and reached only through
 * `createBureau`; the contexts facade, the review records and the steering admission call into it.
 */
import type { AgentDefinitions } from '../agent-catalog';
import type { AnyToolbox } from 'armorer';
import type { BureauCore, SteeringCursor } from './core';
import { BureauError, BureauShuttingDownError, UnpricedSwitchRefusedError } from '../bureau-errors';
import { BureauLedgerConflictError, digestCommandPayload } from '../command-ledger';
import type {
  BureauSteeringGate,
  SessionSteeringState,
  SteeringCommandAdmissionOutcome,
  SteeringCommandRequest,
  createSteeringCommandLedger,
} from '../steering';
import { CONTEXT_WINDOW_TASK_SCAN_LIMIT } from '../bureau-construction-support';
import type { ConditionalTextValueStore } from '@lostgradient/storage';
import type { ContextWindowReport, SessionPendingReview } from '../types';
import {
  type ContextWindowTool,
  type ReportedStepUsage,
  buildContextWindow,
  sizeManagedAssets,
} from '../contexts/context-window';
import {
  FORK_OPERATION_VERSION,
  type ForkLedgerClaim,
  type ForkLedgerFailure,
  type ForkLedgerResult,
  type ForkSessionRequest,
  type ForkSessionResult,
  SessionForkRefusedError,
  assertBranchPoint,
} from '../session-fork';
import {
  ForkThroughMessageError,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  type SessionStore,
  type SteeringRequestedValue,
  createSessionHandle,
  hasDefinitionResolver,
  sessionOriginOf,
  sessionOwnerOf,
} from '@lostgradient/operative';
import {
  allowedDescriptorsOfFileAgent,
  readFileAgentBinding,
  readFileAgentCostBudget,
} from '../agent-file-catalog';
import { allowsModelOverride, describeAgentModels } from '../agent-models';
import { ownerOrLocal } from '../owner-of-record';
import { runtimeWorkspaceOwnerAuthority } from '../http/workspace-principal.ts';
import { unpricedSwitchReason } from '../file-agent-cost-budget';

/** The callables session forks reads from elsewhere in `constructBureau`. */
export interface SessionForksPeers {
  /** The reviews pending on any run of this Bureau. */
  readonly listPendingReviews: () => SessionPendingReview[];
  /** Admits one steering request for a session. */
  readonly admitSteeringRequest: (
    sessionId: string,
    request: SteeringCommandRequest,
  ) => Promise<SteeringCommandAdmissionOutcome>;
  /** Folds the durable steering log of a session into its cursor. */
  readonly catchUpSteering: (
    kv: ConditionalTextValueStore,
    sessionId: string,
    incarnation: string,
  ) => Promise<SteeringCursor>;
  /** `runtime.kv`, when this Bureau keeps durable steering. */
  readonly durableSteeringStore: () => ConditionalTextValueStore | undefined;
  /** Runs an operation after every earlier steering log operation for the session. */
  readonly enqueueSteering: <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>;
  /** The configured session store; throws when there is none. */
  readonly requireSessionStore: () => SessionStore;
}

/** Builds the session forks of one Bureau. Synchronous, and registers nothing. */
export function createSessionForks<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: SessionForksPeers,
) {
  const {
    options,
    workspace,
    assetServiceHolder,
    runtimeServices,
    store,
    runtime,
    runToolboxesByRunId,
    steeringGates,
    inFlightSteeringSubmissions,
    steeringCommandLedger,
    submittedSteeringValues,
  } = core;

  /**
   * AB-67/AB-199 — admit a `pause`/`resume` steering command. Pre-admission
   * checks reuse `submitSessionInput`'s fixed order (authorization, then
   * session lifecycle, then capability): an unauthorized caller or unknown
   * `sessionId` returns `not-found`; an authorized caller naming an
   * already-terminal session returns `session-terminal`. Every target other
   * than `pause`/`resume`, and a durably-configured bureau's `pause`/
   * `resume`, returns `unsupported-capability` before this session's
   * `SteeringGate` is ever consulted or created — see
   * `SteeringCommandAdmissionOutcome`'s doc comment for the exact reasons.
   */
  async function submitSteeringCommand(
    sessionId: string,
    request: SteeringCommandRequest,
  ): Promise<SteeringCommandAdmissionOutcome> {
    // Copied before anything awaits: every check and the decision itself
    // read this copy, so a caller changing its own request object later
    // cannot alter what was validated (its run, or its requested value).
    const snapshot = structuredClone(request);
    // A durable submission reads the engine and the log from its first
    // await to its last, so shutdown waits for the whole of it before it
    // disposes either; once shutdown starts, none begins.
    if (peers.durableSteeringStore() === undefined)
      return peers.admitSteeringRequest(sessionId, snapshot);
    if (core.runAdmissionClosed) {
      throw new BureauShuttingDownError(
        'Cannot steer: Bureau is shutting down.',
        runtimeServices.clock.nowISO(),
      );
    }
    const submission = peers.admitSteeringRequest(sessionId, snapshot);
    inFlightSteeringSubmissions.add(submission);
    try {
      return await submission;
    } finally {
      inFlightSteeringSubmissions.delete(submission);
    }
  }

  /**
   * COR-1921 — why a session of `agentName`'s agent may not be switched to `override` because the
   * agent has `limits.cost` and the model's row has no price in the catalog, or `undefined` when
   * it may. The agent is a file agent, bound or `ephemeral` (tried): a code-defined agent has no
   * budget. The row judged is the one the agent's generate runs for the switch.
   */
  function unpricedSwitchRefusalOf(
    agentName: string,
    override: { readonly model: string; readonly provider?: string | undefined },
  ): string | undefined {
    const agent = core.agentCatalog.find(agentName) ?? core.tryAgents.peek(agentName);
    const budgeted = agent === undefined ? undefined : readFileAgentCostBudget(agent);
    if (budgeted === undefined) return undefined;
    return unpricedSwitchReason(
      budgeted.budget,
      allowedDescriptorsOfFileAgent(budgeted.models, core.models.catalog().descriptors),
      override,
    );
  }

  /**
   * COR-1559 — whether `agentName`'s agent allows a session to be switched to `override`: the
   * model must be one `bureau.agents.models` lists for it. A routed or opaque agent lists none, so
   * every override is refused; only an agent this Bureau cannot find is left to the deployment's
   * catalog, which the caller has already checked. A file agent's model must also be one the
   * host's resolver can set up: a model it cannot is not allowed.
   */
  function agentAllowsModel(
    agentName: string,
    override: { readonly model: string; readonly provider?: string | undefined },
  ): boolean {
    const agent = core.agentCatalog.find(agentName) ?? core.tryAgents.peek(agentName);
    if (agent === undefined) return true;
    const descriptors = core.models.catalog().descriptors;
    const allowed = describeAgentModels(agent, descriptors);
    if (!allowsModelOverride(allowed.models, override)) return false;
    if (readFileAgentBinding(agent) === undefined || options.models?.generate === undefined) {
      return true;
    }
    const row = descriptors.find(
      (descriptor) =>
        descriptor.model === override.model &&
        (override.provider === undefined || descriptor.provider === override.provider) &&
        allowsModelOverride(allowed.models, {
          model: descriptor.model,
          provider: descriptor.provider,
        }),
    );
    if (row === undefined) return false;
    try {
      core.models.generate(row);
      return true;
    } catch {
      return false;
    }
  }

  /** Fork attempts this process is running, by ledger identity, so a concurrent retry waits for one. */
  const inFlightForks = new Map<string, { digest: string; result: Promise<ForkSessionResult> }>();

  async function forkSession(
    sessionId: string,
    request: ForkSessionRequest,
  ): Promise<ForkSessionResult> {
    if (core.runAdmissionClosed) {
      throw new BureauShuttingDownError(
        'Cannot fork: Bureau is shutting down.',
        runtimeServices.clock.nowISO(),
      );
    }
    const identity = {
      callerId: request.owner,
      target: sessionId,
      requestId: request.commandId,
      operationVersion: FORK_OPERATION_VERSION,
    };
    const digest = digestCommandPayload({ throughMessageId: request.throughMessageId });
    const key = JSON.stringify([identity.callerId, identity.target, identity.requestId]);
    const running = inFlightForks.get(key);
    if (running !== undefined) {
      if (running.digest !== digest) throw forkConflict(request);
      return running.result;
    }
    const attempt = runForkAttempt(sessionId, request, identity, digest);
    inFlightForks.set(key, { digest, result: attempt });
    try {
      return await attempt;
    } finally {
      inFlightForks.delete(key);
    }
  }

  function forkConflict(request: ForkSessionRequest): SessionForkRefusedError {
    return new SessionForkRefusedError(
      'command-conflict',
      `The command "${request.commandId}" was already used to branch from another message.`,
    );
  }

  async function runForkAttempt(
    sessionId: string,
    request: ForkSessionRequest,
    identity: Parameters<typeof core.forkLedger.claim>[0],
    digest: string,
  ): Promise<ForkSessionResult> {
    const sessions = runtime.sessionStore;
    if (sessions === undefined) {
      throw new BureauError('This Bureau keeps no sessions to branch.', 'BAD_REQUEST');
    }
    // A command already answered is answered again without judging the branch point afresh: the
    // parent may have changed since, and the retry must see what the first attempt made.
    const located = await core.forkLedger.locate(identity);
    const retained = located.state === 'retained' ? located.entry : undefined;
    if (retained?.state === 'completed' && retained.payloadDigest === digest) {
      return answerOfFork(retained.result);
    }
    const session = await sessions.load(sessionId);
    // COR-1911 — a tried chat has no agent to continue a branch with: its agent is held for it
    // alone, so a branch of it is a context that cannot run. It reads as one that does not exist.
    if (session === undefined || sessionOriginOf(session.metadata) === 'try') {
      throw new BureauError(`Session "${sessionId}" not found`, 'NOT_FOUND');
    }
    if (retained === undefined) {
      await assertBranchPoint(session, request.throughMessageId, {
        record: (runId) => core.tasks.record(runId),
        pendingApprovals: async (runId) => {
          const live = peers
            .listPendingReviews()
            .filter((review) => review.kind === 'tool-approval' && review.runId === runId)
            .map((review) => review.id);
          const view = await core.tasks.get(runId);
          const durable = (view?.openWaits ?? [])
            .filter((wait) => wait.kind === 'tool-approval')
            .map((wait) => wait.reviewId);
          return [...new Set([...live, ...durable])];
        },
      });
    }
    const parentSteering = await getSessionSteering(sessionId);
    const parentRequest = await latestModelRequest(sessionId);
    let outcome: Awaited<ReturnType<typeof core.forkLedger.claim>>;
    try {
      outcome = await core.forkLedger.claim(identity, digest, {
        contextId: runtimeServices.identifiers.next('session'),
        override: parentRequest ?? parentSteering?.model ?? null,
        effort: parentSteering?.effort ?? null,
        permissionMode: parentSteering?.permissionMode ?? null,
      });
    } catch (error) {
      if (error instanceof BureauLedgerConflictError) throw forkConflict(request);
      throw error;
    }
    if (outcome.entry.state === 'completed') return answerOfFork(outcome.entry.result);
    const claim = outcome.entry.claim;
    // The identifier is the claim's, so an attempt that died after forking finds its fork, and one
    // that died before it makes the fork under the identifier the ledger already holds.
    try {
      await createSessionHandle(sessionId, {
        store: sessions,
        agentName: session.agentName,
        runtime: runtimeServices,
      }).fork({
        throughMessageId: request.throughMessageId,
        id: claim.contextId,
        owner: request.owner,
      });
    } catch (error) {
      // The parent was deleted, or the message with it, after the checks: nothing was created. The
      // command settles to that failure rather than staying pending, so a retry is refused alike.
      if (!(error instanceof ForkThroughMessageError)) throw error;
      // A fork before the first message names no message: the parent itself is what went away.
      const failure: ForkLedgerFailure = {
        failure:
          error.messageId === null
            ? { reason: 'context-not-found', message: error.message }
            : { reason: 'message-not-found', message: error.message },
      };
      await core.forkLedger.complete(outcome.entry, failure);
      return answerOfFork(failure);
    }
    const carried =
      claim.override === null
        ? null
        : await carryModelOverride(claim.contextId, {
            id: `${request.commandId}:model`,
            principal: request.owner,
            // As the parent asked: a policy reference is submitted as a reference, and resolved
            // afresh like any carried request; otherwise the explicit override.
            requestedValue:
              claim.override.policyRef === undefined
                ? {
                    target: 'model',
                    override: claim.override.model,
                    ...(claim.override.provider === null
                      ? {}
                      : { provider: claim.override.provider }),
                  }
                : { target: 'model', policyRef: claim.override.policyRef },
          });
    // COR-1935: the effort goes the same way. The claim keeps it, so a retry after a restart
    // carries the one the first attempt read, and a claim from before the field carries none.
    const carriedEffort =
      claim.effort === undefined || claim.effort === null
        ? null
        : await submitSteeringCommand(claim.contextId, {
            id: `${request.commandId}:effort`,
            principal: request.owner,
            requestedValue: { target: 'effort', override: claim.effort },
          });
    // COR-1936: and the permission mode, so a branch of a read-only chat is read-only.
    const carriedPermissionMode =
      claim.permissionMode === undefined || claim.permissionMode === null
        ? null
        : await submitSteeringCommand(claim.contextId, {
            id: `${request.commandId}:permission-mode`,
            principal: request.owner,
            requestedValue: { target: 'permission-mode', override: claim.permissionMode },
          });
    const result: ForkSessionResult = {
      contextId: claim.contextId,
      carriedOverride: carried,
      carriedEffort,
      carriedPermissionMode,
    };
    const completed = await core.forkLedger.complete(outcome.entry, result);
    return answerOfFork(completed.result);
  }

  /**
   * Admits the model a fork carries from its parent. An agent whose `limits.cost` cannot count the
   * model (COR-1921: its price left the catalog since) refuses it, and the fork answers the carry
   * as rejected, as it does a model the agent no longer allows, rather than failing half made.
   */
  async function carryModelOverride(
    contextId: string,
    request: SteeringCommandRequest,
  ): Promise<SteeringCommandAdmissionOutcome> {
    try {
      return await submitSteeringCommand(contextId, request);
    } catch (error) {
      if (!(error instanceof UnpricedSwitchRefusedError)) throw error;
      return {
        outcome: 'rejected',
        failure: { failedAt: runtimeServices.clock.nowISO(), reason: 'policy-denied' },
      };
    }
  }

  /**
   * The session's latest admitted `model` request as it was made, from the steering record itself
   * (COR-1560): the accepted command with the highest version, and, where Bureau resolved a
   * `policyRef` into that command, the reference the caller submitted. A durable Bureau reads the
   * folded log; an in-process one reads its ledger and the references it kept. `undefined` when
   * the session has had no model request.
   */
  async function latestModelRequest(
    sessionId: string,
  ): Promise<ForkLedgerClaim['override'] | undefined> {
    const session = await runtime.sessionStore?.load(sessionId);
    if (session === undefined) return undefined;
    const kv = peers.durableSteeringStore();
    let ledger: ReturnType<typeof createSteeringCommandLedger> = steeringCommandLedger;
    const gate = steeringGates.get(sessionId);
    let selectors: Map<string, Map<string, SteeringRequestedValue>> = (gate === undefined
      ? undefined
      : submittedSteeringValues.get(gate)) ?? new Map();
    if (kv !== undefined) {
      const cursor = await peers.enqueueSteering(sessionId, () =>
        peers.catchUpSteering(kv, sessionId, session.incarnation),
      );
      ledger = cursor.ledger;
      selectors = cursor.submitted;
    }
    let latest: { principal: string; id: string; version: number; at: string } | undefined;
    for (const [principal, commands] of ledger) {
      for (const [id, command] of commands) {
        if (command.sessionId !== sessionId || command.requestedValue.target !== 'model') continue;
        if (command.state !== 'accepted' && command.state !== 'applied') continue;
        if (
          latest === undefined ||
          command.configVersion > latest.version ||
          (command.configVersion === latest.version && command.requestedAt > latest.at)
        ) {
          latest = { principal, id, version: command.configVersion, at: command.requestedAt };
        }
      }
    }
    if (latest === undefined) return undefined;
    const resolved = ledger.get(latest.principal)?.get(latest.id)?.requestedValue;
    if (resolved?.target !== 'model' || resolved.override === undefined) return undefined;
    const selector = selectors.get(latest.principal)?.get(latest.id);
    const policyRef =
      selector !== undefined && 'policyRef' in selector ? selector.policyRef : undefined;
    return {
      provider: resolved.provider ?? null,
      model: resolved.override,
      ...(policyRef === undefined ? {} : { policyRef }),
    };
  }

  /** What a ledger result answers: the fork, or the refusal the command settled to. */
  function answerOfFork(result: ForkLedgerResult): ForkSessionResult {
    if ('failure' in result) {
      if (result.failure.reason === 'context-not-found') {
        throw new BureauError(result.failure.message, 'NOT_FOUND');
      }
      throw new SessionForkRefusedError(result.failure.reason, result.failure.message);
    }
    return structuredClone(result);
  }

  async function getSessionSteering(sessionId: string): Promise<SessionSteeringState | undefined> {
    const session = runtime.sessionStore ? await runtime.sessionStore.load(sessionId) : undefined;
    if (session === undefined) return undefined;
    const kv = peers.durableSteeringStore();
    let gate: BureauSteeringGate | undefined;
    if (kv === undefined) {
      gate = steeringGates.get(sessionId);
    } else {
      try {
        const cursor = await peers.enqueueSteering(sessionId, () =>
          peers.catchUpSteering(kv, sessionId, session.incarnation),
        );
        gate = cursor.gate;
      } catch (error) {
        // A session deleted while its log was read has no steering to report.
        const afterFailure = await runtime.sessionStore?.load(sessionId);
        if (afterFailure?.incarnation !== session.incarnation) return undefined;
        throw error;
      }
    }
    const desired = gate?.getDesiredState();
    return {
      model:
        desired?.model === undefined
          ? null
          : { provider: desired.modelProvider ?? null, model: desired.model },
      effort: desired?.effort ?? null,
      permissionMode: desired?.permissionMode ?? null,
      configVersion: gate?.getConfigVersion() ?? 0,
    };
  }

  /**
   * COR-1937 — the context-window report of a context. Read-only: the history is the session's
   * persisted one, the instructions and tool schemas come from the agent (or, while this process
   * holds the context's latest run, that run's own toolbox), and the reported usage comes from the
   * latest step recorded for the context. No model is called and nothing is written.
   */
  async function getContextWindow(
    contextId: string,
    windowOptions?: { readonly incarnation?: string | undefined },
  ): Promise<ContextWindowReport | undefined> {
    // Read before the first await: the caller's options are not read again.
    const expectedIncarnation = windowOptions?.incarnation;
    const sessions = peers.requireSessionStore();
    const session = await sessions.load(contextId);
    if (session === undefined) return undefined;
    if (expectedIncarnation !== undefined && session.incarnation !== expectedIncarnation) {
      return undefined;
    }
    const steering = await getSessionSteering(contextId);
    // Deleted while its steering was read.
    if (steering === undefined) return undefined;
    const agent =
      core.agentCatalog.find(session.agentName) ?? core.tryAgents.peek(session.agentName);
    const catalog = core.models.catalog().descriptors;
    const named =
      steering.model ?? (agent === undefined ? null : describeAgentModels(agent, catalog).default);
    const model =
      named === null
        ? undefined
        : catalog.find(
            (row) =>
              row.model === named.model &&
              (named.provider === null || row.provider === named.provider),
          );

    // Newest first; a context's latest step is the last step of its newest task that has one. One
    // page of `CONTEXT_WINDOW_TASK_SCAN_LIMIT` tasks bounds the reads of a report that clients
    // poll: a context whose newest tasks all ended before a step reports `usedReported: null`.
    const latest = await core.tasks.enumerate({
      contextId,
      limit: CONTEXT_WINDOW_TASK_SCAN_LIMIT,
      offset: 0,
    });
    let reported: ReportedStepUsage | undefined;
    for (const task of latest.tasks) {
      const liveStep = store.getRun(task.id)?.steps.at(-1);
      // A run this process no longer holds keeps its steps in the durable checkpoint.
      const checkpointed =
        liveStep === undefined ? await runtime.durable?.checkpointStore.loadSteps(task.id) : [];
      const step = liveStep ?? checkpointed?.at(-1);
      if (step === undefined) continue;
      reported = step.usage;
      break;
    }

    const liveToolbox = latest.tasks.map((task) => runToolboxesByRunId.get(task.id)).find(Boolean);
    let toolbox: Pick<AnyToolbox, 'tools'> | undefined = liveToolbox;
    if (toolbox === undefined && agent !== undefined && hasDefinitionResolver(agent)) {
      // The agent's own definition resolves to the toolbox a run of it would start with: a pure
      // build, no run and no model call.
      const resolved = await agent[OPERATIVE_RESOLVE_RUN_OPTIONS]('window', {});
      toolbox = resolved.toolbox;
    }
    const tools: ContextWindowTool[] = (toolbox?.tools() ?? []).map((tool) => {
      const described = tool.toJSON();
      return {
        name: described.name,
        description: described.description,
        input: described.input,
      };
    });

    // Every read above belongs to the incarnation loaded first: an id deleted and created again
    // while they ran is a different context, and this report would mix the two.
    const current = await sessions.load(contextId);
    if (current?.incarnation !== session.incarnation) return undefined;

    // A managed asset is sized from its descriptor as the session's owner, so no bytes are read.
    const assetService = assetServiceHolder.current;
    const owner = ownerOrLocal(sessionOwnerOf(session.metadata) ?? undefined);
    const resolvedSources =
      assetService === undefined
        ? undefined
        : await sizeManagedAssets(session.conversationHistory, async (assetId) => {
            const descriptor = await assetService.inspect(assetId, {
              id: owner,
              workspaceAuthority: runtimeWorkspaceOwnerAuthority(workspace, owner),
            });
            return {
              state: descriptor.state,
              custody: descriptor.custody,
              mediaType: descriptor.mediaType,
              byteLength: descriptor.byteLength,
            };
          });

    return buildContextWindow({
      history: session.conversationHistory,
      instructions: agent === undefined ? undefined : instructionsOf(agent),
      tools,
      model,
      catalog,
      reported,
      resolvedSources,
    });
  }

  /** The system instructions an agent was created with (`createAgent`'s `instructions`), if it declares any. */
  function instructionsOf(agent: object): string | undefined {
    const declared: unknown = Reflect.get(agent, 'instructions');
    return typeof declared === 'string' ? declared : undefined;
  }

  return {
    submitSteeringCommand,
    unpricedSwitchRefusalOf,
    agentAllowsModel,
    forkSession,
    getSessionSteering,
    getContextWindow,
  };
}
