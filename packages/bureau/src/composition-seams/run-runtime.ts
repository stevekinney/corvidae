/**
 * Run runtime (COR-2376 slice R2): the model-policy hold on a run's `generate`, the chat
 * permission governing a run's toolbox, the media options of a run, and `createRunRuntime`,
 * which assembles the generate, toolbox and hooks a run executes with. Built by
 * `buildRuntimeComposition` and reached only through `createRuntimeComposition`.
 * `resolveGuardrailsConfiguration` and `createBureauInvariantHooks` stay in the parent: the core's
 * `bureauChildInvariants` reaches the second above the seam block, and the second reads the first.
 */
import { type AnyToolbox, type ToolRequestContext, createToolbox } from 'armorer';
import {
  BUREAU_HOOK_TIER,
  registerGuardrailInvariants,
  registerIdentityInvariant,
} from '../bureau-invariant-hooks';
import type {
  BureauToolbox,
  MediaRowHolder,
  MediaRunOptions,
  RunRuntimeRequest,
  SessionAgentRun,
  SkillRecoveryOutcome,
} from '../runtime-composition-types';
import type { CompositionCore } from './core';
import {
  DEFAULT_TAINT_THRESHOLD,
  type GenerateFunction,
  type GenerationMode,
  type GuardrailsOptions,
  type JSONValue,
  type OperativeHookMap,
  type RunOptions,
  createGuardrails,
  createSessionTaintTracker,
  readBackendDescriptors,
  withActiveSkillToolPolicy,
  withBackendDescriptors,
  withSessionTaint,
} from '@lostgradient/operative';
import { HookRegistry } from '@lostgradient/lifecycle';
import {
  type RunMemoryTarget,
  createMemoryPersistHook,
  createMemoryRecallHook,
  createRunMemoryAuthority,
} from '../run-memory';
import type { SessionTaintSeam } from '../session-taint-seam';
import {
  type SkillActivationRecord,
  type ToolPolicy,
  createSkillArtifactLoader,
  createSkillClient,
  createSkillClientToolbox,
  renderActiveSkillInstructions,
  renderClientCatalog,
} from '../skills';
import {
  activeSkillToolPolicy,
  agentSkillsRun,
  createSkillGuardrailOptions,
} from '../agent-skills';
import { createSkillRecordSnapshotHook, createUnavailableToolbox } from '../skill-step-metadata';
import { defaultBureauAgentName, withDefaultToolboxRequestContext } from '../run-request-context';
import { holdGenerateToModelPolicy } from '../code-agent-model-policy';
import { ownerOrLocal } from '../owner-of-record';
import { serializeUnknownError } from '../serialization';
import { withAddedTools, withToolboxLayer } from '../toolbox-additions';
import { withChatPermission } from '../tool-approval';

/** The callables run runtime reads from elsewhere in `buildRuntimeComposition`. */
export interface RunRuntimePeers {
  /** The seed and write-back of the taint of one run of a session. */
  readonly sessionTaintSeamFor: (
    sessionId: string,
    runId: string,
    metadata: Readonly<Record<string, JSONValue>> | undefined,
  ) => SessionTaintSeam;
  /** The guardrail configuration in force for this composition. */
  readonly resolveGuardrailsConfiguration: () => GuardrailsOptions | undefined;
}

/**
 * Builds the run runtime of one composition. Synchronous, and registers nothing.
 */
export function createRunRuntimeSeam(core: CompositionCore, peers: RunRuntimePeers) {
  const {
    options,
    dependencies,
    diagnose,
    runtimeServices,
    skillEvents,
    kv,
    memory,
    memoryTenantId,
    skillCatalog,
    skillsConfigured,
    hasSkillTools,
    sessionStore,
    baseToolbox,
    fallbackToolbox,
    configuredGenerate,
  } = core;

  /** {@link RuntimeComposition.holdToModelPolicy}. */
  function holdToModelPolicy<Options extends Pick<RunOptions, 'generate'>>(
    resolved: Options,
    generationMode: GenerationMode,
  ): Options {
    const generate = holdGenerateOfAgent(resolved.generate, generationMode);
    return generate === resolved.generate ? resolved : { ...resolved, generate };
  }

  /** A catalog agent's `generate`, held to the model policy when this composition reads one. */
  function holdGenerateOfAgent(
    generate: GenerateFunction,
    generationMode: GenerationMode,
  ): GenerateFunction {
    const policy = dependencies.modelPolicy;
    return policy === undefined
      ? generate
      : holdGenerateToModelPolicy(generate, policy, generationMode);
  }

  /** {@link RuntimeComposition.withChatPermission}. */
  function governedByChat(toolbox: BureauToolbox, runId: string): BureauToolbox {
    const read = dependencies.permissionModeOfRun;
    return read === undefined
      ? toolbox
      : withChatPermission(
          toolbox,
          () => read(runId),
          // A chat whose mode cannot be read holds its runs to `read-only`: say so, once per call.
          (error) =>
            diagnose({
              level: 'error',
              scope: 'permission-mode',
              message: `[bureau] The permission mode of the chat of run "${runId}" could not be read, so its tool calls are held to read-only: ${serializeUnknownError(error)}`,
              cause: error,
            }),
        );
  }

  /** {@link RuntimeComposition.mediaOptionsFor}. */
  function mediaOptionsFor(
    principalId: string | undefined,
    rowHolder: MediaRowHolder,
  ): MediaRunOptions {
    const resolver = dependencies.contentSourceResolverFor?.(principalId);
    const admitter = dependencies.generatedMediaAdmitterFor?.(principalId, rowHolder);
    const assetSafety = peers.resolveGuardrailsConfiguration()?.input?.assetSafety;
    return {
      ...(resolver === undefined ? {} : { contentSourceResolver: resolver }),
      ...(admitter === undefined ? {} : { generatedMediaAdmitter: admitter }),
      ...(assetSafety === undefined ? {} : { assetSafety }),
    };
  }

  function createRunRuntime(
    request: RunRuntimeRequest,
    runtimeOptions?: {
      /**
       * Active-skill entries to seed the run's {@link SkillSession} with on
       * construction. Used by the durable recovery path: when
       * `buildRunDepsFromSession` rebuilds deps for a recovered run, it reads the
       * `activeSkillRecords` snapshot from session metadata and passes it here so the
       * recovered toolbox is aware of skills activated in completed pre-crash steps
       * (those steps are memoized and do not re-run their `activate_skill` calls).
       */

      /**
       * Provenance-carrying records for the catalog-backed path.
       *
       * Recovery
       * re-validates these against the live catalog and re-checks each digest, so a skill whose
       * source was revoked or whose content drifted does not come back.
       */
      initialActiveSkillRecords?: ReadonlyArray<SkillActivationRecord> | undefined;

      /**
       * COR-1577 — the named catalog agent this session run executes. Its `generate` and toolbox
       * replace the Bureau-wide ones; everything else the Bureau composes around a run still
       * applies.
       */
      sessionAgent?: SessionAgentRun | undefined;

      /**
       * COR-1546 — the run's owner of record, which its memory is partitioned under: the session's
       * owner for a chat run, the schedule's for a fire, `anonymous:local` for a run no principal started
       * (the owner of anything created with none stated). A caller that omits it
       * gets the request authority's `ownerId`; `createBureau` always states it.
       */
      memoryOwner?: string | undefined;
      /**
       * COR-2105 — the metadata of the session the run belongs to. The run's Bureau guardrails
       * start tainted when it holds `guardrailTaint`, and write a taint they raise back to the
       * session. Absent, the run starts untainted and still writes back.
       */
      sessionMetadata?: Readonly<Record<string, JSONValue>> | undefined;
      skillPolicyUnverifiable?: boolean | undefined;
      /**
       * COR-1911 — the run neither recalls memory nor remembers its answers: no memory hook is
       * registered. A run of an agent that is being tried is one; it is a throwaway, and leaves
       * nothing in the memory its owner keeps.
       */
      withoutMemory?: boolean | undefined;
      admitDispatch?: (() => Promise<boolean>) | undefined;
    },
  ) {
    const sessionAgent = runtimeOptions?.sessionAgent;
    const requestContext = request.requestContext;
    // COR-1996: a catalog agent's generate is held to the model policy; the Bureau-wide one is the
    // deployment's own and no agent's choice.
    const underlyingGenerate =
      sessionAgent !== undefined
        ? holdGenerateOfAgent(sessionAgent.options.generate, sessionAgent.generationMode)
        : configuredGenerate;

    if (!underlyingGenerate) {
      throw new Error('No generate function configured');
    }
    const validateDispatch = async (candidate: ToolRequestContext): Promise<boolean> => {
      if (runtimeOptions?.admitDispatch !== undefined && !(await runtimeOptions.admitDispatch()))
        return false;
      return (
        core.requestAuthorityValidator === undefined ||
        (await core.requestAuthorityValidator(candidate))
      );
    };
    const generate: GenerateFunction = withBackendDescriptors(async (context) => {
      const revision = requestContext?.authority.authorizationRevision;
      const required =
        options.workspace !== undefined ||
        (revision !== undefined && revision !== 'bureau:1' && revision !== 'bureau:scheduler:1');
      if (
        required &&
        (!requestContext ||
          !core.requestAuthorityValidator ||
          !(await validateDispatch(requestContext)))
      ) {
        throw new Error('Request authority is no longer current.');
      }
      return underlyingGenerate(context);
    }, readBackendDescriptors(underlyingGenerate));

    // Clone the toolbox for this run so concurrent runs do not share a single
    // CompletableEventTarget emitter. A shared emitter would route every tool.*
    // event (execute-start, settled, …) to ALL runs that have subscribed, causing
    // cross-run event pollution and shared budget/loop-detector state.
    // `extend()` (no args) creates a fresh toolbox with a new emitter while
    // preserving all tool configurations, context, and policy from the original.
    // The unavailable-toolbox sentinel (no user toolbox, no skill tools) is
    // structurally distinct (custom throwing execute) and must be freshly
    // instantiated per-call via createUnavailableToolbox() instead.
    //
    // The skills path below adds the skill tools with withAddedTools, which
    // keeps this clone's own wrappers — so the result is still based on a
    // per-run clone, which is correct.
    //
    // COR-1577 — a named agent's resolved toolbox is its own: `createAgent` builds a fresh one
    // per resolution unless the agent was handed a shared toolbox, which `extend()` clones for
    // the same cross-run isolation the Bureau-wide toolbox gets.
    let toolbox: AnyToolbox =
      sessionAgent !== undefined
        ? sessionAgent.options.toolbox.extend()
        : options.toolbox !== undefined
          ? baseToolbox.extend()
          : hasSkillTools
            ? fallbackToolbox.extend()
            : createUnavailableToolbox();
    // COR-567 — one registry per run. Per-run rather than per-composition
    // because these hooks close over this run's session, memory and skill
    // session; a registry shared across runs would leak one run's state into
    // another exactly the way the per-run toolbox clone above exists to
    // prevent.
    //
    // Registration order is the order the legacy arrays ran in, and every id
    // below is explicit: a generated `<hookName>#<n>` would renumber whenever
    // an earlier conditional block stops registering, so an observer
    // correlating across runs would see the same hook under different names
    // depending on whether memory or skills happened to be configured.
    // COR-1265 — `source` names the owning tier once, and `on()` stamps it onto
    // every entry. On the entry rather than only here because a merged plan has
    // one registry and many tiers: afterwards this object can no longer say
    // where an entry came from, but the entry still can.
    const hooks = new HookRegistry<OperativeHookMap>({ source: BUREAU_HOOK_TIER });
    let getActiveSkillRecords = (): readonly SkillActivationRecord[] => [];
    let getActiveSkillToolPolicy: (() => ToolPolicy | undefined) | undefined;
    // COR-1620: set when the policy that governs the run cannot be verified, from the start or
    // once a stored skill is refused on recovery. The run then offers no tool and writes no
    // skill snapshot, so what it persisted before is kept, and an approval it raises is refused
    // at approve.
    let skillPolicyUnverified = runtimeOptions?.skillPolicyUnverifiable === true;

    if (options.identity) {
      registerIdentityInvariant(hooks, options.identity);
    }

    // COR-41 — memory hooks run only under a persisted request authority. A
    // recovered run whose authority could not be restored gets none: no
    // conversation can reach memory outside the authority it was granted.
    const memoryAuthority =
      memory && requestContext && runtimeOptions?.withoutMemory !== true
        ? createRunMemoryAuthority(
            requestContext,
            {
              runId: request.runId ?? request.sessionId,
              tenantId: memoryTenantId(),
              // A caller that states no owner (a composition used directly) is partitioned by the request
              // authority's own owner, so two requests never share one partition.
              ownerId: ownerOrLocal(
                runtimeOptions?.memoryOwner ?? requestContext.authority.ownerId,
              ),
            },
            options.memoryAuthority,
          )
        : undefined;
    // COR-1546 — an agent remembers across every chat its owner has with it, so the collection is
    // the agent's identifier and never the session's.
    const memoryTarget: RunMemoryTarget = {
      collection: request.agentName ?? requestContext?.agentId ?? defaultBureauAgentName,
      sessionId: request.sessionId,
    };
    // COR-1226 — resolved here rather than at the hook-registration site below,
    // because the skill toolbox needs the same detectors and the same session
    // taint tracker, and it is constructed before that point. `createGuardrails`
    // is a pure function of its options, so calling it earlier changes nothing
    // about what it returns.
    const guardrailsConfig = peers.resolveGuardrailsConfiguration();
    // COR-2105 — a run of a session starts from the session's taint and writes a new one back,
    // from this tracker as from the agent's own (`AgentRunContext.sessionTaint`).
    const runIdOfTaint = request.runId ?? request.sessionId;
    const taintSeam = peers.sessionTaintSeamFor(
      request.sessionId,
      runIdOfTaint,
      runtimeOptions?.sessionMetadata,
    );
    const guardrails = guardrailsConfig
      ? createGuardrails(withSessionTaint(guardrailsConfig, taintSeam, runIdOfTaint))
      : undefined;
    // COR-2107 — the tracker a flagged recall taints. It is the Bureau's own tracker, seeded from
    // the session and writing back through the same seam every other tracker of the run uses
    // (COR-2105), so the taint it raises is stored whichever tier resolved the run's guardrails.
    // Taint is a session fact (COR-2385): when the Bureau runs no guardrails, a tracker over the
    // same seam stands in, for every kind of agent and for a run with none, so an opt-out of
    // guardrails never decides whether a flagged recall taints the session.
    const recallTaint =
      guardrails?.taint ??
      createSessionTaintTracker({
        ...(taintSeam.initial === undefined ? {} : { initial: taintSeam.initial }),
        onTainted: taintSeam.onTainted,
        runId: runIdOfTaint,
      });

    if (memory && memoryAuthority) {
      // COR-2107 — a recall a detector flagged at or above the run's taint threshold taints the
      // session, as any other scan path does (COR-2102).
      // The agent's own declared threshold judges its recall first (COR-2385), then the Bureau's.
      const recallTaintThreshold =
        sessionAgent?.agentTaintThreshold ??
        guardrailsConfig?.taint?.taintThreshold ??
        DEFAULT_TAINT_THRESHOLD;
      hooks.on(
        'prepareStep',
        createMemoryRecallHook(memory, memoryAuthority, memoryTarget, (detection, step) => {
          if (detection.confidence < recallTaintThreshold) return;
          recallTaint.taint({
            reason: `Recalled memory flagged by ${detection.detector} (${detection.category})`,
            detector: detection.detector,
            category: detection.category,
            confidence: detection.confidence,
            step,
            provenance: 'recalled-memory',
          });
          // The write that stores the taint completes before the recall hook returns, as
          // the guardrail hooks' own does (COR-2105).
          return recallTaint.settled();
        }),
        {
          id: 'bureau:memory-recall',
          // Recall admission records the read and can quarantine a poisoned
          // record; both are idempotent on a replayed step.
          replay: 'effectful',
        },
      );
      hooks.on(
        'onStep',
        createMemoryPersistHook(memory, memoryAuthority, memoryTarget, request.runId, (receipt) =>
          diagnose({
            level: 'warn',
            scope: 'memory',
            message:
              `[bureau] Governed memory rejected the answer of run "${request.runId ?? request.sessionId}" ` +
              `for agent "${memoryTarget.collection}" (${receipt.reason ?? 'no reason given'}), so it was not remembered.`,
          }),
        ),
        {
          id: 'bureau:memory-persist',
          // Writes to the memory store, so a replayed step writes again. The
          // classification records that at-least-once contract; it does not
          // suppress the second write, which would drop the persistence for a
          // step whose generation genuinely re-ran.
          replay: 'effectful',
        },
      );
    }

    // COR-1226 — skill bodies and skill resources are untrusted instruction
    // input and must pass the same detector pipeline as anything else entering
    // context. `GuardrailHooks.taint`'s own doc comment names skill resources
    // as one of the retrieval surfaces that cannot reach the model through
    // `prepareStep`/`validateResponse` and so must scan directly and fold its
    // detections back into the session-wide taint state. The wiring is
    // `createSkillGuardrailOptions` from `./agent-skills`, which
    // `createAgentSkills` uses for per-agent skills too (COR-1367), so the
    // two paths cannot drift.
    const skillGuardrail =
      guardrails && guardrailsConfig
        ? createSkillGuardrailOptions(guardrailsConfig, guardrails)
        : undefined;

    let skillRecovery: Promise<SkillRecoveryOutcome> | undefined;
    // COR-323: the named agent's own skills. Its client already owns the run's toolbox and the
    // catalog prompt, so Bureau adds only what the agent cannot see: the durable snapshot of the
    // active set after every step, and the re-validation of a stored set on recovery.
    const agentSkills = agentSkillsRun(sessionAgent?.options.hooks);
    if (agentSkills !== undefined) {
      const { client, catalog } = agentSkills;
      const recoverable = runtimeOptions?.initialActiveSkillRecords;
      if (recoverable !== undefined && recoverable.length > 0) {
        skillRecovery = agentSkills.recover(recoverable).then((outcome) => {
          if (outcome.refused.length > 0) skillPolicyUnverified = true;
          return outcome;
        });
      }
      getActiveSkillRecords = () => client.activationRecords();
      getActiveSkillToolPolicy = () => activeSkillToolPolicy(client.narrowedTools());
      if (sessionStore) {
        const writeSkillSnapshot = createSkillRecordSnapshotHook(
          client,
          catalog,
          request.sessionId,
          sessionStore,
          request.runId,
        );
        hooks.on(
          'onStep',
          async (context) => {
            if (!skillPolicyUnverified) await writeSkillSnapshot(context);
          },
          { id: 'bureau:skill-record-snapshot', replay: 'effectful' },
        );
      }
    } else if (options.skills && skillCatalog !== undefined) {
      // COR-892 — the catalog-backed path. Bureau composes policy and durability *around*
      // Agent-owned behaviour rather than reimplementing it: discovery, trust admission,
      // digest-verified activation and the active set all live in `@lostgradient/bureau/skills`, and what
      // Bureau adds here is the run and session correlation the client cannot see, plus durable
      // persistence of what the client decided.
      const skillClient = createSkillClient({
        catalog: skillCatalog,
        ...(options.skills.currentCatalog === undefined
          ? {}
          : { currentCatalog: options.skills.currentCatalog }),
        // Routed by source kind rather than fixed to the filesystem: a catalog can mix a host's
        // filesystem roots with the bureau's own store, and a `storage` record's `sourceLocation`
        // is a store namespace that no filesystem read can follow.
        loadArtifact: createSkillArtifactLoader(kv === undefined ? {} : { storage: kv }),
        // COR-1226's scan, carried onto the client path. Migrating without it would have created
        // the guardrail bypass COR-892 names: skill bodies are untrusted instruction input and
        // pass the same detector pipeline as anything else entering context.
        ...(skillGuardrail === undefined ? {} : { guardrail: skillGuardrail }),
        ...(skillEvents === undefined ? {} : { events: skillEvents }),
        correlation: {
          ...(request.runId === undefined ? {} : { runId: request.runId }),
          sessionId: request.sessionId,
          ...(request.agentName === undefined ? {} : { agentName: request.agentName }),
        },
      });

      // Recovery before anything else reads the active set: a resumed run must re-validate every
      // stored record against the live catalog and re-check its digest, so a skill whose source
      // was revoked or whose content drifted while the run was away does not come back.
      const recoverable = runtimeOptions?.initialActiveSkillRecords;
      if (recoverable !== undefined && recoverable.length > 0) {
        // Detached deliberately: composition is synchronous, and recovery re-reads bundles. The
        // first step's `prepareStep` awaits the same promise below, so nothing reads a half-filled
        // active set.
        skillRecovery = skillClient.recover(recoverable).then((outcome) => {
          if (outcome.refused.length > 0) skillPolicyUnverified = true;
          return outcome;
        });
      }

      // The records verbatim, not a name-and-policy projection of them. The projection was what
      // the provider-backed snapshot could carry; narrowing to it here would throw away the
      // provenance every reader of this snapshot now depends on.
      getActiveSkillRecords = () => skillClient.activationRecords();
      getActiveSkillToolPolicy = () => activeSkillToolPolicy(skillClient.narrowedTools());

      if (options.skills.includeTools !== false) {
        const skillToolset = createSkillClientToolbox(
          skillClient,
          skillGuardrail === undefined ? undefined : { guardrail: skillGuardrail },
        );
        // `undefined` when the admitted catalog is empty, so no skill tool is exposed at all —
        // a model handed `activate_skill` against an empty catalog invents a name to pass it.
        if (skillToolset !== undefined) {
          hooks.on(
            'prepareStep',
            (context) => {
              if (context.step !== 0) return Promise.resolve();
              const rendered = renderClientCatalog(skillClient);
              if (rendered !== undefined) {
                context.conversation.appendSystemMessage(rendered, {
                  _skillCatalogInjected: true,
                });
              }
              return Promise.resolve();
            },
            {
              id: 'bureau:skill-client-catalog',
              // Reads the client's frozen catalog revision and appends to the
              // step's conversation; nothing outside it is touched.
              replay: 'safe',
            },
          );

          toolbox = withAddedTools(
            toolbox,
            createToolbox([
              skillToolset.activateSkill,
              skillToolset.loadSkillResource,
              skillToolset.deactivateSkill,
            ]) as AnyToolbox,
          );
        }
      }

      // Active instructions are re-rendered every step rather than left in the transcript, which
      // is what makes them survive a compaction strategy that rewrote the whole history.
      hooks.on(
        'prepareStep',
        async (context) => {
          // Recovery settles before the first step reads the active set, so nothing renders a
          // half-filled one.
          if (skillRecovery !== undefined) await skillRecovery;
          const instructions = renderActiveSkillInstructions(skillClient.active());
          if (instructions !== undefined) {
            context.conversation.appendSystemMessage(instructions, { _skillContentInjected: true });
          }
        },
        {
          id: 'bureau:skill-client-instructions',
          // Renders the active set into the step's conversation. Re-rendering on
          // a replayed step is the point — see the comment above — and reaches
          // nothing outside that conversation.
          replay: 'safe',
        },
      );

      if (sessionStore) {
        const writeSkillSnapshot = createSkillRecordSnapshotHook(
          skillClient,
          skillCatalog,
          request.sessionId,
          sessionStore,
          request.runId,
        );
        hooks.on(
          'onStep',
          async (context) => {
            // What an unverified policy persisted before is kept: a snapshot of the skills this
            // run holds now would replace the one that governs the call.
            if (!skillPolicyUnverified) await writeSkillSnapshot(context);
          },
          {
            id: 'bureau:skill-record-snapshot',
            // Writes the activation records to the session store.
            replay: 'effectful',
          },
        );
      }
    }

    // AB-40 — `undefined` (not configured) wires the enabled-by-default
    // preset; `false` opts out entirely; anything else replaces the preset.
    // COR-1577 — an agent that resolves its own guardrails was handed this bureau's policy as
    // its inherited one and applies it in its own hook tier, exactly as a catalog dispatch does.
    if (guardrails && sessionAgent?.agentResolvesGuardrails !== true) {
      // Registered last on `prepareStep`, as the array push order had it, so
      // the input guardrail scans a step context every earlier hook has
      // already contributed to rather than one they then append to.
      registerGuardrailInvariants(hooks, guardrails);
    }

    // Records the run was given but no skill client is configured to enforce cannot be honoured.
    if (
      !skillsConfigured &&
      agentSkills === undefined &&
      (runtimeOptions?.initialActiveSkillRecords?.length ?? 0) > 0
    ) {
      skillPolicyUnverified = true;
    }
    const skillToolPolicy: (() => ToolPolicy | undefined) | undefined =
      getActiveSkillToolPolicy === undefined && !skillPolicyUnverified
        ? undefined
        : () => (skillPolicyUnverified ? { allowList: [] } : getActiveSkillToolPolicy?.());
    // COR-1947 — nearest the tools: a layer, so what is added to the run later is held to it too.
    const chatToolbox =
      request.runId === undefined ? toolbox : governedByChat(toolbox, request.runId);
    const runToolbox = withDefaultToolboxRequestContext(
      // COR-1228 — narrow by active-skill policy first, then apply the request
      // context. Order matters only for readability here: both are proxies and
      // neither observes the other, but filtering nearest the toolbox keeps the
      // request-context wrapper the outermost thing a caller sees.
      skillToolPolicy
        ? withToolboxLayer(chatToolbox, (rebuilt) =>
            withActiveSkillToolPolicy(rebuilt, skillToolPolicy),
          )
        : chatToolbox,
      requestContext,
      () => validateDispatch,
      runtimeServices,
    );
    return Promise.resolve({
      generate,
      toolbox: runToolbox,
      hooks,
      // COR-2387: where a scan outside the loop (a durable child wait's answer) stores its taint.
      onToolResultTaint: taintSeam.onTainted,
      getActiveSkillRecords,
      // Records the run was given but no skill client is configured to enforce: all are refused.
      skillPolicyUnverified: () => skillPolicyUnverified,
      skillsRecovered:
        skillRecovery ??
        Promise.resolve({
          recovered: [],
          refused: (runtimeOptions?.initialActiveSkillRecords ?? []).map((record) => record.name),
        }),
    });
  }

  return { holdToModelPolicy, governedByChat, mediaOptionsFor, createRunRuntime };
}
