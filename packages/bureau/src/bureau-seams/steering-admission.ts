/**
 * Steering admission (COR-2376 slice S7): admit one steering request for a session, bind a durable
 * steering command to its key, resolve the live run a session input addresses, and answer a
 * cross-session command from the target's log. Built by `constructBureau` and reached only through
 * `createBureau`; session forks, session input admission and session input gates call into it.
 */
import {
  type ActiveRun,
  type AgentSession,
  type Effort,
  PERMISSION_MODES,
  type PermissionMode,
  SteeringAcceptedEvent,
  type SteeringRequestedValue,
} from '@lostgradient/operative';
import type { AgentDefinitions } from '../agent-catalog';
import {
  type BureauCore,
  STEERING_APPEND_ATTEMPTS,
  type SteeringCursor,
  type SteeringFoldHistory,
} from './core';
import { BureauError, UnpricedSwitchRefusedError } from '../bureau-errors';
import {
  type BureauSteeringGate,
  type ImplementedSteeringCommand,
  type SteeringCommandAdmissionOutcome,
  type SteeringCommandRequest,
  type SteeringRefusal,
  answerSteeringRetry,
  createSteeringCommandLedger,
  createSteeringGate,
  getSteeringLedgerEntry,
  isConfigurationTarget,
  steersIdleSession,
} from '../steering';
import type { ConditionalTextValueStore } from '@lostgradient/storage';
import {
  type SteeringKeyBinding,
  SteeringLogCorruptError,
  type SteeringLogEvent,
  appendSteeringLogEvent,
  isReadableSteeringLogEvent,
  readSteeringKeyBinding,
  readSteeringLogEntries,
  readSteeringLogHead,
  steeringSessionRunTag,
} from '../steering-log';
import { isSessionAuthorityAuthorized, resolveSessionPreAdmission } from '../session-authority';
import { modelPolicyDenialOf } from '../model-policy';
import { modelPolicyOf } from '../settings/settings-options';

/** The callables steering admission reads from elsewhere in `constructBureau`. */
export interface SteeringAdmissionPeers {
  /** The session id of a run this process holds. */
  readonly getRunSessionIdentifier: (runState: { activeRun: ActiveRun }) => string;
  /** Whether an agent definition permits a model. */
  readonly agentAllowsModel: (
    agentName: string,
    override: { readonly model: string; readonly provider?: string | undefined },
  ) => boolean;
  /** The refusal of a model switch to a model with no price, if any. */
  readonly unpricedSwitchRefusalOf: (
    agentName: string,
    override: { readonly model: string; readonly provider?: string | undefined },
  ) => string | undefined;
  /** Applies one steering log event to a session gate and its cursor. */
  readonly applySteeringEvent: (
    gate: BureauSteeringGate,
    refusals: Map<string, Map<string, SteeringRefusal>>,
    event: SteeringLogEvent,
    submitted?: Map<string, Map<string, SteeringRequestedValue>>,
    history?: SteeringFoldHistory,
  ) => SteeringCommandAdmissionOutcome | undefined;
  /** Applies one steering log event to a cursor. */
  readonly applyToCursor: (
    cursor: SteeringCursor,
    event: SteeringLogEvent,
  ) => SteeringCommandAdmissionOutcome | undefined;
  /** The submitted retry of a steering command, if the value was submitted before. */
  readonly asSubmittedRetry: (
    ledger: ReturnType<typeof createSteeringCommandLedger>,
    refusals: Map<string, Map<string, SteeringRefusal>>,
    submitted: Map<string, Map<string, SteeringRequestedValue>>,
    command: ImplementedSteeringCommand,
    rawSubmission?: SteeringRequestedValue,
  ) => ImplementedSteeringCommand;
  /** Folds the durable steering log of a session into its cursor. */
  readonly catchUpSteering: (
    kv: ConditionalTextValueStore,
    sessionId: string,
    incarnation: string,
  ) => Promise<SteeringCursor>;
  /** A fresh fold history for one pass over a steering log. */
  readonly createSteeringFoldHistory: () => SteeringFoldHistory;
  /** `runtime.kv`, when this Bureau keeps durable steering. */
  readonly durableSteeringStore: () => ConditionalTextValueStore | undefined;
  /** Runs an operation after every earlier steering log operation for the session. */
  readonly enqueueSteering: <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>;
  /** The session's steering gate, created on first use. */
  readonly getSessionSteeringGate: (sessionId: string) => BureauSteeringGate;
  /** Adds a value to the set under a two-level key. */
  readonly nestedSet: <T>(
    map: Map<string, Map<string, T>>,
    outer: string,
    inner: string,
    value: T,
  ) => void;
  /** The refusal of a steering append that kept losing its race. */
  readonly steeringContention: (sessionId: string) => BureauError;
}

/** Builds the steering admission of one Bureau. Synchronous, and registers nothing. */
export function createSteeringAdmission<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: SteeringAdmissionPeers,
) {
  const {
    runtimeServices,
    store,
    emitter,
    agentsSnapshot,
    runtime,
    currentSettings,
    steeringCursors,
    steeringRunIncarnations,
    settledLocalRunIds,
    steeringCommandLedger,
    submittedSteeringValues,
  } = core;

  async function admitSteeringRequest(
    sessionId: string,
    request: SteeringCommandRequest,
  ): Promise<SteeringCommandAdmissionOutcome> {
    const session = runtime.sessionStore ? await runtime.sessionStore.load(sessionId) : undefined;
    if (!session) {
      return { outcome: 'not-found' };
    }

    // AB-67/AB-199 review finding (PR #430 — Codex P2): genuinely enumerate
    // this session's live runs through the store's own run registry, rather
    // than inferring cardinality/liveness from the single
    // `metadata['lastRunId']` field — a field that "identifies only the
    // most recently persisted writer, not the sole non-terminal run" under
    // real concurrent runs. `store.getState().runs` + `getRunSessionIdentifier`
    // is Bureau's own existing live-run registry (used identically by
    // `listRuns`/`listPendingReviews` above), not new infrastructure.
    // Computed BEFORE the terminal check below (review finding, PR #430 —
    // Codex P2, "Consult live runs before declaring the session terminal"):
    // `metadata['lastRunStatus']` reflects only the MOST RECENTLY persisted
    // run's own completion, which can go terminal while an OLDER, still
    // non-terminal concurrent run on the same session remains genuinely
    // live — a metadata-only check would reject a command explicitly
    // targeting that still-live run.
    //
    // Computed BEFORE the authorization check too (review finding, PR #430
    // — Codex P2, "Authorize against the targeted live run"): resolving
    // which run this command actually targets — the caller's own explicit
    // `runId`, or the session's sole live run when omitted — lets
    // authorization consult THAT run's own `lastRequestAuthorities` entry
    // directly, rather than a single-run default (`metadata['lastRunId']`),
    // which a DIFFERENT concurrent run's more recent terminal transition can
    // leave pointing at an unrelated, uncorrelated entry. COR-718: authorization
    // now compares the session's owner, which every run on it shares; the
    // targeting is kept for the liveness computation that follows.
    // This computation touches only the internal run registry, never
    // anything derived from `request.principal`, so it leaks nothing to an
    // unauthorized caller ahead of the `not-found` check below.
    // A request naming its run is authorized before anything else runs: the
    // backend-wide liveness query below must neither be triggered by, nor
    // leak its failures to, a caller who may not see this session.
    if (
      request.runId !== undefined &&
      !isSessionAuthorityAuthorized(session.metadata, request.principal, request.runId)
    ) {
      return { outcome: 'not-found' };
    }
    // A key the log already decided is answered by admission from the log,
    // which authorizes the caller against the run that answer discloses:
    // nothing here depends on which runs are live now, so a backend that is
    // unavailable must not stand between a retry and its recorded answer.
    // A new decision is checked here, and again inside admission.
    const keyAlreadyBound = await durableSteeringKeyIsBoundHere(
      sessionId,
      session.incarnation,
      request.principal,
      request.id,
    );
    let liveRunIds: string[] = [];
    if (!keyAlreadyBound) {
      const preAdmission = await resolveLiveSessionPreAdmission(
        sessionId,
        session,
        request.principal,
        request.runId,
        steersIdleSession(request.requestedValue),
      );
      if (preAdmission.verdict === 'not-found') return { outcome: 'not-found' };
      if (preAdmission.verdict === 'session-terminal') {
        return { outcome: 'session-terminal', sessionId };
      }
      liveRunIds = preAdmission.liveRunIds;
    }
    // A refusal Bureau decides here, before the gate, is logged like the
    // gate's own refusals on a durable session, so a caller-supplied id
    // stays decided: a later retry is answered from the log, not re-judged
    // against a catalog or policy that may have changed since.
    // Refused after a `policyRef` resolved, the logged command carries the
    // resolved value that was validated and refused, and the selector is
    // kept beside it, exactly as for an admission.
    const refuseSteering = async (
      outcome: SteeringRefusal['outcome'],
      resolvedFromSelector?: ImplementedSteeringCommand['requestedValue'],
    ): Promise<SteeringCommandAdmissionOutcome> => {
      const kv = peers.durableSteeringStore();
      if (kv === undefined || request.id === undefined) return outcome;
      const refused: ImplementedSteeringCommand = {
        id: request.id,
        idOrigin: 'caller',
        sessionId,
        principal: request.principal,
        requestedValue: resolvedFromSelector ?? request.requestedValue,
        requestedAt: runtimeServices.clock.nowISO(),
        ...(request.expectedRevision !== undefined
          ? { expectedRevision: request.expectedRevision }
          : {}),
        ...(request.deadline !== undefined ? { deadline: request.deadline } : {}),
        ...(request.runId !== undefined ? { runId: request.runId } : {}),
      };
      return peers.enqueueSteering(sessionId, () =>
        admitDurableSteeringCommand(
          kv,
          session.incarnation,
          refused,
          () => liveSessionRunIdsEverywhere(sessionId, session.incarnation, request.runId),
          outcome,
          resolvedFromSelector === undefined ? undefined : request.requestedValue,
        ),
      );
    };
    // AB-200/AB-68: all seven targets reach the gate. `agent-identity` is
    // validated against the agents map below, and `model`/`provider`/
    // `effort` are validated against the model catalog; `route` is not,
    // because Bureau holds no routing table (see the `known` check below).
    // A configuration `policyRef` is first resolved through
    // `modelPolicy.users` (COR-1227). The gate then owns their
    // desired-state writes and per-run `configVersion` accounting.
    const steeringTarget = request.requestedValue.target;
    // A `policyRef` names a pre-approved policy only the AB-66 selector can
    // resolve into a concrete agent name. Until that resolution path exists
    // here, a `policyRef`-carrying command is unsupported rather than
    // guessed at — validating an unresolved reference against the agents
    // map would reject every legitimate policy name.
    if (steeringTarget === 'agent-identity' && request.requestedValue.policyRef !== undefined) {
      return refuseSteering({ outcome: 'unsupported-capability', reason: 'selector-unavailable' });
    }
    // A durably-configured bureau with no resolved storage backend cannot
    // persist a command, and admitting one into the in-memory gate would
    // silently lose it on restart — exactly what the durable contract
    // exists to prevent. That combination is not reachable through normal
    // composition (durable execution resolves ON only when a persistent
    // backend is configured), so this stays a guard rather than a path.
    if (runtime.durable && runtime.durableStorage === undefined) {
      return { outcome: 'unsupported-capability', reason: 'durable-steering-unavailable' };
    }
    // `SteeringRequestedValue`'s own contract: an agent-identity `override`
    // "must be a key of Bureau<D>'s agents map". Validated against the
    // construction-time snapshot every other agent lookup in this module
    // uses, so a name this Bureau cannot run is refused at admission rather
    // than surfacing as an unresolvable agent at the next run's step 0.
    //
    // `policy-denied`: this deployment's own catalog is what refuses the
    // change, which is what that reason already means. (COR-1559 has since
    // widened the union with `model-not-allowed`, `stale-revision` and
    // `shutting-down`, for the reasons that name something `policy-denied`
    // does not.)
    if (
      steeringTarget === 'agent-identity' &&
      !Object.hasOwn(agentsSnapshot, request.requestedValue.override)
    ) {
      return refuseSteering({
        outcome: 'rejected',
        failure: { failedAt: runtimeServices.clock.nowISO(), reason: 'policy-denied' },
      });
    }

    // AB-200 — validate a configuration override against the live model
    // catalog, coordinate by coordinate.
    //
    // NOT through `models.plan`, and the reason is a real constraint
    // rather than a preference. `composePolicy`'s exact-override path
    // (`providers/policy.ts`'s `matchesOverride`) requires provider AND
    // model together — "a partially specified override cannot resolve to
    // one candidate, so it matches nothing" — and rejects any override
    // naming a `route`, because `route` is not a field `BackendDescriptor`
    // carries. A steering command addresses exactly one coordinate, so it
    // can never satisfy that path: routing every one of them through
    // `models.plan` would reject every legitimate single-coordinate
    // command as `no-candidate`. That is the catalog gap AB-65 names.
    //
    // What a steering override actually needs to answer is narrower: "is
    // this coordinate one the deployment knows about?" The accumulated
    // desired configuration is recomputed into a full plan at the runStep
    // selection boundary anyway (AB-250's revalidation), which is where
    // whole-backend coherence is decided. Admission's job is only to stop
    // a value the catalog has never heard of.
    //
    // The one cast: every target the gate cannot admit has already
    // returned above (the four configuration targets are admitted, and
    // `agent-identity` with a `policyRef` returned at the policyRef check),
    // so this value genuinely is one of the gate's accepted variants.
    // TypeScript cannot carry that narrowing across the intervening
    // statements because the checks are separate early returns rather than
    // one discriminating switch.
    let resolvedRequestedValue =
      request.requestedValue as ImplementedSteeringCommand['requestedValue'];
    if (isConfigurationTarget(steeringTarget)) {
      // Narrowing `steeringTarget` does not narrow `request.requestedValue`:
      // they are separate bindings, so the predicate above tells TypeScript
      // nothing about the value's own discriminant. Bind the narrowed view
      // once here rather than casting at each field access.
      const configurationRequest = request.requestedValue as Extract<
        SteeringRequestedValue,
        { target: 'route' | 'model' | 'provider' | 'effort' | 'permission-mode' }
      >;

      // COR-1227 — resolve a `policyRef` to a concrete coordinate.
      //
      // A policyRef names a key of `BureauModelPolicyOptions.users`, whose
      // own doc comment fixes that meaning: "Named policy profiles are keys
      // of `users`". Resolution reads that profile's coordinate for this
      // target and admits the concrete value, so the stored command records
      // what was actually chosen rather than an unresolved reference a
      // later reader would have to re-resolve against possibly-changed
      // configuration.
      //
      // Not through `models.plan`, for the reason the override path below
      // documents: `composePolicy`'s exact-override test needs provider and
      // model together and rejects routes outright, so a single-coordinate
      // request can never satisfy it.
      // `Effort` is a union of string literals, so `string` already
      // covers every coordinate this can hold.
      let override: string | undefined = configurationRequest.override;
      if (configurationRequest.policyRef !== undefined) {
        const users = modelPolicyOf(currentSettings())?.users;
        const profile =
          users !== undefined && Object.hasOwn(users, configurationRequest.policyRef)
            ? users[configurationRequest.policyRef]
            : undefined;
        if (profile === undefined) {
          // Unknown policy name. Distinct from the case below, and the
          // caller is entitled to tell them apart: one is a typo or a
          // decommissioned profile, the other is a profile that simply
          // says nothing about this coordinate.
          return refuseSteering({
            outcome: 'rejected',
            failure: { failedAt: runtimeServices.clock.nowISO(), reason: 'policy-denied' },
          });
        }
        override =
          steeringTarget === 'model'
            ? profile.exactOverride?.model
            : steeringTarget === 'provider'
              ? profile.exactOverride?.provider
              : steeringTarget === 'route'
                ? profile.exactOverride?.route
                : // COR-1936: a policy profile states no permission mode, so there is nothing
                  // to resolve one from.
                  steeringTarget === 'permission-mode'
                  ? undefined
                  : // `effort` has a dedicated profile field beside the
                    // override, and it is the more natural place for a policy
                    // to express one — `exactOverride.effort` still wins when
                    // both are set, matching the override's name.
                    (profile.exactOverride?.effort ?? profile.defaultEffort);
        if (override === undefined) {
          // The profile exists but specifies nothing for this coordinate.
          // Admitting anything here would be inventing a value the policy
          // never stated.
          return refuseSteering({
            outcome: 'rejected',
            failure: { failedAt: runtimeServices.clock.nowISO(), reason: 'policy-denied' },
          });
        }
        // The resolved value is admitted, not the reference. It still falls
        // through to the identical catalog check the `override` path uses
        // below, so a policy cannot admit a coordinate an override could
        // not — that is the authority guarantee, and it needs no second
        // mechanism.
        resolvedRequestedValue = (
          steeringTarget === 'effort'
            ? { target: 'effort', override: override as Effort }
            : steeringTarget === 'permission-mode'
              ? { target: 'permission-mode', override: override as PermissionMode }
              : { target: steeringTarget, override }
        ) satisfies ImplementedSteeringCommand['requestedValue'];
      }
      const { descriptors } = core.models.catalog();
      // COR-1559: a `model` override may name the provider that serves the model. It is held to
      // the catalog, and below to the agent, as the pair when it does, and as the name alone
      // (every record written before the field existed) when it does not.
      const overrideProvider =
        steeringTarget === 'model'
          ? (configurationRequest as { provider?: string | undefined }).provider
          : undefined;
      const known =
        steeringTarget === 'model'
          ? descriptors.some(
              (descriptor) =>
                descriptor.model === override &&
                (overrideProvider === undefined || descriptor.provider === overrideProvider),
            )
          : steeringTarget === 'provider'
            ? descriptors.some((descriptor) => descriptor.provider === override)
            : steeringTarget === 'effort'
              ? descriptors.some((descriptor) =>
                  descriptor.effort.portable.includes(override as Effort),
                )
              : // COR-1936: a permission mode is Bureau's own, not a catalog row.
                steeringTarget === 'permission-mode'
                ? (PERMISSION_MODES as readonly string[]).includes(override as string)
                : // `route`: a routing entry is configured on the generate
                  // function (`RoutingOptions.routes`), not in the model
                  // catalog, and Bureau does not hold that table. There is
                  // nothing here to validate against, so admission accepts
                  // the name and the routing layer rejects an unknown route
                  // at generate time. Recorded rather than faked: a
                  // membership test against a catalog that structurally
                  // cannot contain routes would reject every valid route.
                  true;
      if (!known) {
        return refuseSteering(
          {
            outcome: 'rejected',
            failure: { failedAt: runtimeServices.clock.nowISO(), reason: 'policy-denied' },
          },
          configurationRequest.policyRef === undefined ? undefined : resolvedRequestedValue,
        );
      }
      // COR-1559: a model a caller names is also held to what the session's agent allows, decided
      // now rather than at a step boundary, and refused through the log like any refusal so a retry
      // is answered the same. Only a steering override is held to it: a model a policy profile
      // resolved is the profile's choice, and one the agent's own routing makes at a step never
      // passes through admission at all.
      if (
        steeringTarget === 'model' &&
        configurationRequest.policyRef === undefined &&
        override !== undefined &&
        !peers.agentAllowsModel(session.agentName, { model: override, provider: overrideProvider })
      ) {
        return refuseSteering(
          {
            outcome: 'rejected',
            failure: { failedAt: runtimeServices.clock.nowISO(), reason: 'model-not-allowed' },
          },
          configurationRequest.policyRef === undefined ? undefined : resolvedRequestedValue,
        );
      }
      // COR-1980: the model policy's deployment and Bureau layers bind a steering choice however it
      // was made, so a model every catalog row of which the policy forbids is refused now, as
      // `policy-denied`, rather than admitted for a step to fail on. A policy profile's resolved
      // model is held to it too: a profile cannot admit what an override could not. A name that
      // also matches an allowed row (another provider's) is admitted; the step judges the row it
      // uses. The policy is read live, so a command admitted before it tightened fails at its step.
      if (steeringTarget === 'model' && override !== undefined) {
        const policy = modelPolicyOf(currentSettings());
        const named = descriptors.filter(
          (descriptor) =>
            descriptor.model === override &&
            (overrideProvider === undefined || descriptor.provider === overrideProvider),
        );
        if (named.every((descriptor) => modelPolicyDenialOf(descriptor, policy) !== undefined)) {
          return refuseSteering(
            {
              outcome: 'rejected',
              failure: { failedAt: runtimeServices.clock.nowISO(), reason: 'policy-denied' },
            },
            configurationRequest.policyRef === undefined ? undefined : resolvedRequestedValue,
          );
        }
      }
    }

    // COR-1921 — a budgeted agent is not switched to a model the catalog cannot price: counting
    // its steps at another model's rate would spend the budget unseen. A key the log already
    // decided (the durable log, or the in-memory ledger of a Bureau with none) is answered from
    // there and skips it. This refusal is a throw, so it is not logged: a retry of it is judged
    // again, and is admitted if the catalog has since gained a price.
    const inMemoryKeyBound =
      peers.durableSteeringStore() === undefined &&
      request.id !== undefined &&
      getSteeringLedgerEntry(steeringCommandLedger, request.principal, request.id) !== undefined;
    if (
      resolvedRequestedValue.target === 'model' &&
      resolvedRequestedValue.override !== undefined &&
      !keyAlreadyBound &&
      !inMemoryKeyBound
    ) {
      const reason = peers.unpricedSwitchRefusalOf(session.agentName, {
        model: resolvedRequestedValue.override,
        provider:
          'provider' in resolvedRequestedValue ? resolvedRequestedValue.provider : undefined,
      });
      if (reason !== undefined) throw new UnpricedSwitchRefusedError(reason);
    }

    const now = runtimeServices.clock.nowISO();
    const id = request.id ?? runtimeServices.identifiers.next('steering-command');
    const command: ImplementedSteeringCommand = {
      id,
      idOrigin: request.id !== undefined ? 'caller' : 'generated',
      sessionId,
      principal: request.principal,
      // For pause/resume/agent-identity this is `request.requestedValue`
      // unchanged, narrowed by the target early returns above. For the four
      // configuration targets it is the selector-resolved coordinate, so a
      // `policyRef` is admitted as the concrete value the plan chose.
      requestedValue: resolvedRequestedValue,
      requestedAt: now,
      ...(request.expectedRevision !== undefined
        ? { expectedRevision: request.expectedRevision }
        : {}),
      ...(request.deadline !== undefined ? { deadline: request.deadline } : {}),
      ...(request.runId !== undefined ? { runId: request.runId } : {}),
    };

    const kv = peers.durableSteeringStore();
    if (kv === undefined) {
      const gate = peers.getSessionSteeringGate(sessionId);
      const outcome = gate.admit(command, { liveRunIds, now });
      if (
        outcome.outcome === 'accepted' &&
        'policyRef' in request.requestedValue &&
        request.requestedValue.policyRef !== undefined
      ) {
        let submitted = submittedSteeringValues.get(gate);
        if (submitted === undefined) {
          submitted = new Map();
          submittedSteeringValues.set(gate, submitted);
        }
        peers.nestedSet(submitted, request.principal, id, request.requestedValue);
      }
      if (outcome.outcome === 'accepted') dispatchSteeringAccepted(sessionId, outcome);
      return outcome;
    }
    const outcome = await peers.enqueueSteering(sessionId, () =>
      admitDurableSteeringCommand(
        kv,
        session.incarnation,
        command,
        () => liveSessionRunIdsEverywhere(sessionId, session.incarnation, request.runId),
        undefined,
        'policyRef' in request.requestedValue && request.requestedValue.policyRef !== undefined
          ? request.requestedValue
          : undefined,
      ),
    );
    if (outcome.outcome === 'accepted') dispatchSteeringAccepted(sessionId, outcome);
    return outcome;
  }

  /**
   * Whether `(principal, id)` is bound in this very session incarnation's
   * log, so admission can answer it from that log and authorize against
   * the run it discloses. A key bound in another session is not: its
   * answer would also reveal this session, so the caller is checked here
   * first like any new request. An unreadable binding reads as unbound
   * here; admission fails closed on it.
   */
  async function durableSteeringKeyIsBoundHere(
    sessionId: string,
    incarnation: string,
    principal: string,
    id: string | undefined,
  ): Promise<boolean> {
    const kv = peers.durableSteeringStore();
    if (kv === undefined || id === undefined) return false;
    try {
      const stored = await readSteeringKeyBinding(kv, principal, id);
      return stored?.binding.sessionId === sessionId && stored.binding.incarnation === incarnation;
    } catch {
      return false;
    }
  }

  /**
   * COR-301/COR-1569 — the pre-admission verdict (AB-42's order:
   * authorization, then lifecycle) that steering and session input share,
   * decided against the session's live runs in every process sharing this
   * backend. A request without `namedRunId` is authorized against the
   * session's sole live run, wherever it runs, and a session with any live
   * run is not terminal, whichever run's terminal write set `lastRunStatus`.
   * Without a durable steering store, this process's runs are all there are.
   */
  async function resolveLiveSessionPreAdmission(
    sessionId: string,
    session: AgentSession,
    principal: string,
    namedRunId?: string,
    idleAllowed = false,
  ): Promise<{
    verdict: 'not-found' | 'session-terminal' | 'proceed';
    liveRunIds: string[];
  }> {
    const notFound = { verdict: 'not-found' as const, liveRunIds: [] as string[] };
    let liveRunIds: string[] = [];
    try {
      const steeringKv = peers.durableSteeringStore();
      if (steeringKv === undefined) {
        liveRunIds = liveSessionRunIds(sessionId);
      } else {
        // Fold the log first: a run promoted elsewhere whose workflow does
        // not exist yet is known only from its `promoted` entry, and the
        // terminal decision below must count it.
        await peers.enqueueSteering(sessionId, () =>
          peers.catchUpSteering(steeringKv, sessionId, session.incarnation),
        );
        liveRunIds = await liveSessionRunIdsEverywhere(sessionId, session.incarnation, namedRunId);
      }
    } catch (error) {
      // Deleted meanwhile by another process: its log was read mid-deletion.
      const afterFailure = await runtime.sessionStore?.load(sessionId);
      if (afterFailure?.incarnation !== session.incarnation) return notFound;
      // A request naming its run sees the failure if it is still authorized
      // against that run on the session as it stands now.
      if (namedRunId !== undefined) {
        if (!isSessionAuthorityAuthorized(afterFailure.metadata, principal, namedRunId)) {
          return notFound;
        }
        throw error;
      }
      // An unscoped request's authority depends on which run is live, so a
      // failed query is masked until this caller is shown to be authorized
      // against the run this process can see.
      const localTarget = liveSessionRunIdsOfIncarnation(sessionId, session.incarnation);
      if (
        !isSessionAuthorityAuthorized(
          afterFailure.metadata,
          principal,
          localTarget.length === 1 ? localTarget[0] : undefined,
        )
      ) {
        return notFound;
      }
      throw error;
    }
    // The live runs were read across awaits that the session itself may
    // have changed under (a new sole run saved with its own authority), so
    // the caller is checked against the session as it stands after them.
    const afterLiveness =
      peers.durableSteeringStore() === undefined
        ? session
        : await runtime.sessionStore?.load(sessionId);
    if (afterLiveness?.incarnation !== session.incarnation) return notFound;
    return {
      verdict: resolveSessionPreAdmission(
        afterLiveness.metadata,
        principal,
        liveRunIds,
        namedRunId,
        idleAllowed,
      ),
      liveRunIds,
    };
  }

  /**
   * This process's running runs of one session incarnation: a run of a
   * deleted incarnation still settling here is not the recreated session's.
   */
  function liveSessionRunIdsOfIncarnation(sessionId: string, incarnation: string): string[] {
    // Only runs steered from this incarnation's log: one started elsewhere
    // (catalog dispatch, a schedule, or recovered without a tag) never reads
    // the gate or logs its end, so a command bound to it could never apply.
    return liveSessionRunIds(sessionId).filter(
      (runId) =>
        !settledLocalRunIds.has(runId) && steeringRunIncarnations.get(runId) === incarnation,
    );
  }

  /** The ids of this process's runs on `sessionId` that are still running. */
  function liveSessionRunIds(sessionId: string): string[] {
    const liveRunIds: string[] = [];
    for (const [runId, runState] of store.getState().runs) {
      if (runState.status === 'running' && peers.getRunSessionIdentifier(runState) === sessionId) {
        liveRunIds.push(runId);
      }
    }
    return liveRunIds;
  }

  /**
   * The session incarnation's live runs, as far as steering and session
   * input admission need to know them, in EVERY process sharing this backend: this process's own
   * running runs, plus non-terminal durable `agentRun` workflows tagged
   * with the session incarnation (`steeringSessionRunTag`), whichever
   * process runs them. A deleted incarnation's still-running workflows carry
   * a different tag and never count.
   *
   * Admission only ever asks three things of this set: is a named run in it,
   * is it empty, and does it hold exactly one run. So it is bounded rather
   * than enumerated: the named run is checked directly, and the tagged query
   * reads at most two other workflows — enough to tell none, one, and
   * ambiguous apart without paging over a result that can change between
   * pages. Without a durable engine, this process's view is all there is.
   */
  /**
   * How long after a run's start is saved it may still lack its workflow.
   * Launch writes the workflow moments later, so this only needs to outlast
   * a slow start, while staying far shorter than any workflow's retention.
   */
  const STEERING_RUN_START_WINDOW_MS = 60_000;

  async function liveSessionRunIdsEverywhere(
    sessionId: string,
    incarnation: string,
    namedRunId?: string,
  ): Promise<string[]> {
    // A run whose `run-ended` this process has folded is over, whatever the
    // engine still reports: its terminal state can lag the event. It is
    // never counted, so it cannot make liveness look conclusive either.
    const endedInLog = (runId: string) => {
      const folded = steeringCursors.get(sessionId);
      return folded?.incarnation === incarnation && folded.history.runs.get(runId) === 'ended';
    };
    const live = new Set<string>();
    const countLive = (runId: string) => {
      if (!endedInLog(runId)) live.add(runId);
    };
    for (const runId of liveSessionRunIdsOfIncarnation(sessionId, incarnation)) countLive(runId);
    const engine = runtime.durable?.engine;
    if (engine === undefined) return [...live].toSorted((left, right) => left.localeCompare(right));
    const tag = steeringSessionRunTag(sessionId, incarnation);
    // The same filter the tag listing applies: a live `agentRun` of this
    // incarnation. Another workflow type carrying the tag is not a run.
    // A saved start counts while its workflow is absent, or present and
    // live: it may have become visible after the listing above.
    const savedWorkflowHasEnded = async (runId: string) => {
      const workflow = await engine.get(runId);
      return workflow !== null && !isLiveSessionWorkflow(workflow);
    };
    const liveAndNotEnded = () => [...live].toSorted((left, right) => left.localeCompare(right));
    const isLiveSessionWorkflow = (workflow: {
      type: string;
      status: string;
      tags?: readonly string[];
    }) =>
      workflow.type === 'agentRun' &&
      ['pending', 'running', 'suspended'].includes(workflow.status) &&
      workflow.tags?.includes(tag) === true;
    if (namedRunId !== undefined && !live.has(namedRunId)) {
      const named = await engine.get(namedRunId);
      if (named !== null && isLiveSessionWorkflow(named)) countLive(namedRunId);
    }
    // Already conclusive without the listing: the named run is live, or
    // unscoped, two runs already make it ambiguous.
    if (namedRunId === undefined ? live.size >= 2 : live.has(namedRunId)) {
      return liveAndNotEnded();
    }
    const others = await engine.list({
      type: 'agentRun',
      status: ['pending', 'running', 'suspended'],
      tags: [tag],
      limit: 2,
    });
    for (const workflow of others.items) countLive(workflow.id);
    // A run is promoted in the log before its tagged workflow exists. Until
    // the engine has any record of it, it counts as starting from its own
    // `promoted` entry, folded into this session's cursor before admission —
    // but only within the launch window its promotion time bounds: a missing
    // workflow long after that is a finished one since purged, not one still
    // starting. Each run has its own marker, so concurrent starts all count.
    //
    // Admission needs only the named run's membership and whether any run is
    // live, or, unscoped, whether zero, one, or several are; the reads stop
    // as soon as that is known. A read either adds a run — a workflow not
    // yet created, or one that became queryable after the list above and is
    // still this incarnation's and live — or drops a marker whose workflow
    // ended, so each marker costs at most one read that adds nothing.
    const cursor = steeringCursors.get(sessionId);
    if (cursor?.incarnation === incarnation) {
      for (const [runId, promotedAt] of cursor.starting) {
        if (runtimeServices.clock.now() - Date.parse(promotedAt) > STEERING_RUN_START_WINDOW_MS) {
          cursor.starting.delete(runId);
        }
      }
      // The session is saved as running a run a moment before that run's
      // `promoted` entry is appended. In that gap the session's latest run
      // is starting too, bounded by its own start time like any marker.
      // Each run is saved as starting, in its own entry, a moment before its
      // `promoted` entry is appended; concurrent starts each keep theirs. In
      // that gap the run is starting too, bounded by its own start time like
      // any marker. The named run, if any, is read first.
      const countSavedStart = async () => {
        const saved = await runtime.sessionStore?.load(sessionId);
        if (saved?.incarnation !== incarnation) return;
        const starting = saved.metadata['steeringStartingRuns'];
        if (typeof starting !== 'object' || starting === null || Array.isArray(starting)) return;
        const entries = Object.entries(starting).toSorted(([left], [right]) =>
          left === namedRunId ? -1 : right === namedRunId ? 1 : 0,
        );
        for (const [savedRunId, savedStartedAt] of entries) {
          if (namedRunId === undefined ? live.size >= 2 : live.has(namedRunId)) return;
          if (
            typeof savedStartedAt === 'string' &&
            !live.has(savedRunId) &&
            !cursor.history.runs.has(savedRunId) &&
            runtimeServices.clock.now() - Date.parse(savedStartedAt) <=
              STEERING_RUN_START_WINDOW_MS &&
            !(await savedWorkflowHasEnded(savedRunId))
          ) {
            countLive(savedRunId);
          }
        }
      };
      // A named run not yet live can still be the saved start or one of
      // the markers; another run being live says nothing about it, so the
      // saved start is read first, then the named run's own marker.
      let namedChecked = namedRunId === undefined || !cursor.starting.has(namedRunId);
      if (namedRunId !== undefined && !live.has(namedRunId)) await countSavedStart();
      const known = () =>
        namedRunId === undefined
          ? live.size >= 2
          : live.has(namedRunId) || (namedChecked && live.size >= 1);
      const markers = [...cursor.starting.keys()];
      if (namedRunId !== undefined && !namedChecked) {
        markers.splice(markers.indexOf(namedRunId), 1);
        markers.unshift(namedRunId);
      }
      for (const runId of markers) {
        if (known()) break;
        if (live.has(runId)) continue;
        const workflow = await engine.get(runId);
        if (workflow === null || isLiveSessionWorkflow(workflow)) countLive(runId);
        else cursor.starting.delete(runId);
        if (runId === namedRunId) namedChecked = true;
      }
      if (namedRunId === undefined && !known()) await countSavedStart();
    }
    return liveAndNotEnded();
  }

  // AB-68: give `steering.accepted` its first production dispatch site.
  // Only the `accepted` transition is dispatched here, and deliberately:
  // `SteeringRejectedEvent`/`SteeringSupersededEvent`/`SteeringFailedEvent`
  // are documented as `accepted → X` transitions, so a PRE-admission
  // rejection (an unknown agent name, an ambiguous run) never reached
  // `accepted` and must not be reported as having left it. Those three
  // belong to the gate's own post-admission transitions.
  function dispatchSteeringAccepted(
    sessionId: string,
    outcome: Extract<SteeringCommandAdmissionOutcome, { outcome: 'accepted' }>,
  ): void {
    emitter.dispatch(
      new SteeringAcceptedEvent(sessionId, outcome.command.id, outcome.command.configVersion),
    );
  }

  /**
   * Durable admission, serialized per session in this process and against
   * other processes by the log head:
   *
   * 1. Catch the session's gate up with the log.
   * 2. Answer a reused `(principal, id)` from what the log already decided:
   *    the gate's ledger for an accepted command, the folded refusals for a
   *    refused one, or — for a key bound in another session — a fold of that
   *    session's log.
   * 3. Otherwise append the `admit` event, binding the key in the same
   *    atomic write, and only then apply it to the local gate. The outcome
   *    is whatever the gate decides from the recorded inputs, which is what
   *    every other process folding the log decides too. Losing the race to
   *    another process's append starts over from step 1.
   */
  async function admitDurableSteeringCommand(
    kv: ConditionalTextValueStore,
    incarnation: string,
    request: ImplementedSteeringCommand,
    liveRunIdsNow: () => Promise<string[]>,
    refusal?: SteeringRefusal['outcome'],
    submittedValueAsSent?: SteeringRequestedValue,
  ): Promise<SteeringCommandAdmissionOutcome> {
    // A private copy: the event appended, the event applied, and what the
    // caller may later mutate must never differ.
    // A revision JSON cannot represent (NaN, an infinity, a fraction, a
    // negative) can never equal a real configVersion, so it is the gate's own
    // `policy-denied` — decided after the usual idempotency lookup, and
    // logged without the unrepresentable field so the id stays decided.
    const revisionIsRepresentable =
      request.expectedRevision === undefined ||
      (Number.isSafeInteger(request.expectedRevision) && request.expectedRevision >= 0);
    const command = structuredClone(request);
    if (!revisionIsRepresentable)
      delete (command as { expectedRevision?: number }).expectedRevision;
    let decidedRefusal: SteeringRefusal['outcome'] | undefined = refusal;
    const submittedValue =
      submittedValueAsSent === undefined ? undefined : structuredClone(submittedValueAsSent);
    const { sessionId, principal, id } = command;
    for (let attempt = 0; attempt < STEERING_APPEND_ATTEMPTS; attempt += 1) {
      // Rechecked here, in the queue: another process may have deleted the
      // session since the caller loaded it.
      const current = await runtime.sessionStore?.load(sessionId);
      if (current?.incarnation !== incarnation) return { outcome: 'not-found' };
      let cursor: SteeringCursor;
      try {
        cursor = await peers.catchUpSteering(kv, sessionId, incarnation);
      } catch (error) {
        // Deleted by another process while its log was being read: a missing
        // entry or a shrunken head is that deletion, not corruption.
        const afterFailure = await runtime.sessionStore?.load(sessionId);
        if (afterFailure?.incarnation !== incarnation) return { outcome: 'not-found' };
        // The failure is the caller's to see only while the caller is still
        // authorized here, on the session as it stands now: the request may
        // have waited in the queue, or skipped the up-front checks entirely
        // as an already-bound key.
        const localTarget = liveSessionRunIdsOfIncarnation(sessionId, incarnation);
        const target = command.runId ?? (localTarget.length === 1 ? localTarget[0] : undefined);
        if (!isSessionAuthorityAuthorized(afterFailure.metadata, principal, target)) {
          return { outcome: 'not-found' };
        }
        throw error;
      }
      const answered = answerSteeringRetry(
        cursor.ledger,
        cursor.refusals,
        peers.asSubmittedRetry(
          cursor.ledger,
          cursor.refusals,
          cursor.submitted,
          command,
          submittedValue,
        ),
      );
      if (answered !== undefined) {
        // The folded answer stands only if the key's binding names this
        // key's own entry in this log: a binding pointing anywhere else is
        // corrupt, here exactly as for a key answered from another session.
        let bindingHolds: boolean;
        try {
          bindingHolds = await steeringBindingNamesOwnEntry(
            kv,
            sessionId,
            incarnation,
            principal,
            id,
          );
        } catch (error) {
          // A deletion by another process removes the entry mid-read: that
          // is the session going away, not corruption.
          const afterFailure = await runtime.sessionStore?.load(sessionId);
          if (afterFailure?.incarnation !== incarnation) return { outcome: 'not-found' };
          throw error;
        }
        // Authority may have changed while this waited in the queue or
        // folded the log: a replay is answered only to a caller still
        // authorized against the run it was decided for, read just now.
        const afterRead = await runtime.sessionStore?.load(sessionId);
        if (afterRead?.incarnation !== incarnation) return { outcome: 'not-found' };
        if (bindingHolds) {
          return isSessionAuthorityAuthorized(
            afterRead.metadata,
            principal,
            steeringAnswerRunId(answered, command),
          )
            ? answered
            : { outcome: 'not-found' };
        }
        // A mismatched binding is reported only to a caller still authorized
        // here; anyone else learns nothing beyond `not-found`.
        const localTarget = liveSessionRunIdsOfIncarnation(sessionId, incarnation);
        const target = command.runId ?? (localTarget.length === 1 ? localTarget[0] : undefined);
        if (!isSessionAuthorityAuthorized(afterRead.metadata, principal, target)) {
          return { outcome: 'not-found' };
        }
        throw new SteeringLogCorruptError(
          `Steering key "${principal}"/"${id}" was decided in session "${sessionId}", but its binding does not name that decision.`,
        );
      }
      if (!revisionIsRepresentable && decidedRefusal === undefined) {
        decidedRefusal = {
          outcome: 'rejected',
          failure: { failedAt: runtimeServices.clock.nowISO(), reason: 'policy-denied' },
        };
      }
      // Only what the log parser can read back is ever appended: the command,
      // and with it the value the caller submitted, if one is kept.
      const probe: SteeringLogEvent =
        decidedRefusal === undefined
          ? {
              type: 'admit',
              command,
              liveRunIds: [],
              now: runtimeServices.clock.nowISO(),
              ...(submittedValue !== undefined ? { submittedValue } : {}),
            }
          : {
              type: 'refused',
              command,
              outcome: decidedRefusal,
              now: runtimeServices.clock.nowISO(),
              ...(submittedValue !== undefined ? { submittedValue } : {}),
            };
      if (!isReadableSteeringLogEvent(probe, sessionId)) {
        if (decidedRefusal !== undefined) return decidedRefusal;
        throw new BureauError('Malformed steering command.', 'BAD_REQUEST');
      }

      let expectedBinding: string | null = null;
      const stored = await readSteeringKeyBinding(kv, principal, id);
      if (stored !== undefined) {
        const { binding } = stored;
        const bindingSession =
          binding.sessionId === sessionId
            ? undefined
            : await runtime.sessionStore?.load(binding.sessionId);
        const live =
          binding.sessionId === sessionId
            ? binding.incarnation === incarnation
            : bindingSession?.incarnation === binding.incarnation;
        if (live) {
          let elsewhere: SteeringCommandAdmissionOutcome | undefined;
          try {
            elsewhere = await answerFromOtherSteeringLog(kv, binding, command, submittedValue);
          } catch (error) {
            if (!(error instanceof SteeringLogCorruptError)) throw error;
          }
          if (elsewhere !== undefined) {
            // The answer discloses the other session's command, so the caller
            // must still be authorized there, against that command's run, on
            // the session as it stands now.
            const boundNow = await runtime.sessionStore?.load(binding.sessionId);
            if (boundNow?.incarnation !== binding.incarnation) continue;
            if (
              !isSessionAuthorityAuthorized(
                boundNow.metadata,
                principal,
                steeringAnswerRunId(elsewhere, command),
              )
            ) {
              return { outcome: 'not-found' };
            }
            // It also tells the caller this session exists, so this session
            // gets the same checks as any request to it, as it stands now:
            // authority against the run the request targets, then whether
            // the session has ended.
            return answerCrossSessionInTarget(
              elsewhere,
              sessionId,
              incarnation,
              command,
              liveRunIdsNow,
            );
          }
          // The binding names a live session whose log does not account for
          // it — unless that session was deleted mid-fold, which is a race,
          // not corruption: decide again once the deletion is visible.
          const recheck = await runtime.sessionStore?.load(binding.sessionId);
          if (recheck?.incarnation !== binding.incarnation) continue;
          throw new SteeringLogCorruptError(
            `Steering key "${principal}"/"${id}" is bound to sequence ${String(binding.sequence)} of session "${binding.sessionId}", which does not admit it.`,
          );
        }
        // Bound by a session incarnation that no longer exists — a deletion
        // that died before removing it. Replaced atomically below.
        expectedBinding = stored.raw;
      }

      // Live runs and the clock are read now, on this attempt, not when the
      // caller queued: a run that ended (and logged it) while this waited
      // must not be bound, and a deadline is judged at the moment of decision.
      // Checked again as close to the append as possible. The log cannot
      // condition on the session record itself (it changes on every save),
      // so a deletion committing in the instant between this read and the
      // append can still win; the orphan it leaves is removed by the boot
      // sweep, and the admission is equivalent to one that landed just
      // before the deletion.
      // Liveness first, then the session: the backend-wide query is awaited,
      // and the session's terminal state must be read after it, not before.
      const liveRunIds = await liveRunIdsNow();
      const stillLive = await runtime.sessionStore?.load(sessionId);
      if (stillLive?.incarnation !== incarnation) return { outcome: 'not-found' };
      // The session's last run may have finished while this waited: the same
      // terminal check `submitSteeringCommand` made up front, made again.
      // The run this command binds to may have changed while it waited (its
      // run ended, another became the sole live one), so authority is
      // checked again against the run it will actually be decided for.
      const preAdmission = resolveSessionPreAdmission(
        stillLive.metadata,
        principal,
        liveRunIds,
        command.runId,
        steersIdleSession(command.requestedValue),
      );
      if (preAdmission === 'not-found') return { outcome: 'not-found' };
      if (preAdmission === 'session-terminal') return { outcome: 'session-terminal', sessionId };
      const now = runtimeServices.clock.nowISO();
      const event: Extract<SteeringLogEvent, { type: 'admit' | 'refused' }> =
        decidedRefusal === undefined
          ? {
              type: 'admit',
              command,
              liveRunIds,
              now,
              ...(submittedValue !== undefined ? { submittedValue } : {}),
            }
          : {
              type: 'refused',
              command,
              outcome: decidedRefusal,
              now,
              // A selector resolved before this refusal was decided is kept,
              // exactly as for an admission, so its exact retry still matches.
              ...(submittedValue !== undefined ? { submittedValue } : {}),
            };
      const appended = await appendSteeringLogEvent(
        kv,
        sessionId,
        incarnation,
        cursor.head,
        event,
        expectedBinding,
      );
      if (appended.status === 'appended') {
        const outcome = peers.applyToCursor(cursor, event);
        cursor.applied += 1;
        cursor.head = appended.head;
        if (outcome === undefined) throw new Error('an admit event always yields an outcome');
        return outcome;
      }
    }
    throw peers.steeringContention(sessionId);
  }

  /**
   * Answers a reused key bound in ANOTHER session from that session's own
   * log, folded into a throwaway gate: the original is there, in whatever
   * state it reached, so the retry gets the same `conflict` it would have
   * got in-process.
   */
  /**
   * Returns `answer`, decided in another session, only if this target
   * session still admits the caller: its live runs read now (a failed read
   * is masked unless the caller is authorized against the run it would
   * target), the caller authorized against the targeted run, and the
   * session not ended. Otherwise `not-found` or `session-terminal`.
   */
  async function answerCrossSessionInTarget(
    answer: SteeringCommandAdmissionOutcome,
    sessionId: string,
    incarnation: string,
    command: ImplementedSteeringCommand,
    liveRunIdsNow: () => Promise<string[]>,
  ): Promise<SteeringCommandAdmissionOutcome> {
    let liveRunIds: string[];
    try {
      liveRunIds = await liveRunIdsNow();
    } catch (error) {
      const afterFailure = await runtime.sessionStore?.load(sessionId);
      if (afterFailure?.incarnation !== incarnation) return { outcome: 'not-found' };
      const localTarget = liveSessionRunIdsOfIncarnation(sessionId, incarnation);
      const target = command.runId ?? (localTarget.length === 1 ? localTarget[0] : undefined);
      if (!isSessionAuthorityAuthorized(afterFailure.metadata, command.principal, target)) {
        return { outcome: 'not-found' };
      }
      throw error;
    }
    const targetNow = await runtime.sessionStore?.load(sessionId);
    if (targetNow?.incarnation !== incarnation) return { outcome: 'not-found' };
    const preAdmission = resolveSessionPreAdmission(
      targetNow.metadata,
      command.principal,
      liveRunIds,
      command.runId,
      steersIdleSession(command.requestedValue),
    );
    if (preAdmission === 'not-found') return { outcome: 'not-found' };
    if (preAdmission === 'session-terminal') return { outcome: 'session-terminal', sessionId };
    return answer;
  }

  /**
   * The run an idempotency answer was decided for: the original command's
   * bound run for a replay or conflict, else the request's own.
   */
  function steeringAnswerRunId(
    answer: SteeringCommandAdmissionOutcome,
    request: ImplementedSteeringCommand,
  ): string | undefined {
    if (answer.outcome === 'replayed') return answer.command.runId;
    if (answer.outcome === 'conflict') return answer.conflict.original.runId;
    return request.runId;
  }

  /**
   * Whether `(principal, id)`'s stored binding names this session
   * incarnation and, at its sequence, an `admit` or `refused` entry for that
   * same key.
   */
  async function steeringBindingNamesOwnEntry(
    kv: ConditionalTextValueStore,
    sessionId: string,
    incarnation: string,
    principal: string,
    id: string,
  ): Promise<boolean> {
    const stored = await readSteeringKeyBinding(kv, principal, id);
    if (
      stored === undefined ||
      stored.binding.sessionId !== sessionId ||
      stored.binding.incarnation !== incarnation
    ) {
      return false;
    }
    const { sequence } = stored.binding;
    const head = await readSteeringLogHead(kv, sessionId, incarnation);
    if (sequence > head.sequence) return false;
    const [named] = await readSteeringLogEntries(
      kv,
      sessionId,
      incarnation,
      sequence - 1,
      sequence,
    );
    return (
      named !== undefined &&
      (named.type === 'admit' || named.type === 'refused') &&
      named.command.principal === principal &&
      named.command.id === id
    );
  }

  async function answerFromOtherSteeringLog(
    kv: ConditionalTextValueStore,
    binding: SteeringKeyBinding,
    command: ImplementedSteeringCommand,
    submittedValue?: SteeringRequestedValue,
  ): Promise<SteeringCommandAdmissionOutcome | undefined> {
    const ledger = createSteeringCommandLedger();
    const refusals = new Map<string, Map<string, SteeringRefusal>>();
    const submitted = new Map<string, Map<string, SteeringRequestedValue>>();
    const gate = createSteeringGate(binding.sessionId, ledger, runtimeServices.clock);
    const head = await readSteeringLogHead(kv, binding.sessionId, binding.incarnation);
    const events = await readSteeringLogEntries(
      kv,
      binding.sessionId,
      binding.incarnation,
      0,
      head.sequence,
    );
    // The binding must name this key's own admission in that log; anything
    // else is a corrupt binding, never an answer.
    const named = events[binding.sequence - 1];
    if (
      named === undefined ||
      (named.type !== 'admit' && named.type !== 'refused') ||
      named.command.principal !== command.principal ||
      named.command.id !== command.id
    ) {
      throw new SteeringLogCorruptError(
        `Steering key "${command.principal}"/"${command.id}" is bound to sequence ${String(binding.sequence)} of session "${binding.sessionId}", which does not admit it.`,
      );
    }
    const history = peers.createSteeringFoldHistory();
    for (const event of events) peers.applySteeringEvent(gate, refusals, event, submitted, history);
    return answerSteeringRetry(
      ledger,
      refusals,
      peers.asSubmittedRetry(ledger, refusals, submitted, command, submittedValue),
    );
  }

  return { admitSteeringRequest, resolveLiveSessionPreAdmission, liveSessionRunIdsEverywhere };
}
