import type { HookReplayPolicy } from '@lostgradient/lifecycle';
import type {
  MemoryCapability,
  MemoryAuthority,
  GovernedMemory,
  MemoryEvidenceBundle,
  MemoryRecallDetection,
  MemoryWriteReceipt,
} from '@lostgradient/memory';
import { MEMORY_CAPABILITIES, createMemoryAuthority, requestPrincipal } from '@lostgradient/memory';
import type { PrepareStepHook, OnStepHook } from '@lostgradient/operative';
import { MEMORY_EVIDENCE_METADATA_KEY } from '@lostgradient/operative';
import type { ToolRequestContext } from 'armorer';
import { Conversation, getOwn, messageText } from 'conversationalist';
import type { BureauMemoryAuthorityOptions } from './bureau-types/options';

/** COR-41 — what Bureau delegates to a run when the deployment configures nothing else. */
export const DEFAULT_RUN_MEMORY_CAPABILITIES: readonly MemoryCapability[] = Object.freeze([
  'memory:search',
  'memory:write',
]);
/** The default ceiling for memory tools listed by an agent file. */
export const DEFAULT_TOOL_MEMORY_CAPABILITIES: readonly MemoryCapability[] = Object.freeze([
  'memory:search',
  'memory:write',
  'memory:get',
  'memory:delete',
]);
const MEMORY_TOOL_CAPABILITIES: Readonly<Record<string, readonly MemoryCapability[]>> =
  Object.freeze({
    memory_recall: ['memory:search'],
    memory_store: ['memory:write'],
    memory_correct: ['memory:get', 'memory:write'],
    memory_forget: ['memory:delete'],
  });
/**
 * COR-1546 — who a run's memory belongs to. Memory is partitioned by the Bureau's deployment
 * (`tenantId`) and the run's owner of record (`ownerId`), the same pair `bureau.memory.*` builds
 * its authority from, so what a chat run remembers is what its owner's own operations list. It is
 * never the request authority's `tenantId` and `ownerId`: those are the tool-execution authority,
 * and a run that states none gets the agent's name as its owner (`normalizeRunRequestContext`).
 */
export type RunMemoryIdentity = {
  readonly runId: string;
  /** The Bureau's identifier, which is the tenant memory is partitioned under. */
  readonly tenantId: string;
  /** The run's owner of record: `anonymous:local` when none was recorded. */
  readonly ownerId: string;
};
/**
 * COR-1546 — where a run's memory is kept: the agent's identifier is the collection, so an agent
 * remembers across every chat its owner has with it, and the session that produced a record is
 * written into the record's `metadata`.
 */
export type RunMemoryTarget = {
  /** The agent's identifier. */
  readonly collection: string;
  readonly sessionId: string;
};
/**
 * COR-41 — the memory authority a run acts under, derived from its persisted
 * request authority. The delegation chain runs from Bureau (holding the
 * deployment's `runCapabilities`) through the request principal to the run, so
 * every memory record and receipt names who acted, for whom, and under which
 * authorization revision. Explicit `memory:*` capabilities on the request can
 * only narrow the deployment grant; a request that names none receives it.
 */
export function createRunMemoryAuthority(
  requestContext: ToolRequestContext,
  run: RunMemoryIdentity,
  options: BureauMemoryAuthorityOptions = {},
): MemoryAuthority {
  const deployment = options.runCapabilities ?? DEFAULT_RUN_MEMORY_CAPABILITIES;
  const known = new Set<string>(MEMORY_CAPABILITIES);
  const requested = requestContext.authority.capabilities.filter((capability) =>
    known.has(capability),
  );
  const granted =
    requested.length === 0
      ? deployment
      : deployment.filter((capability) => requested.includes(capability));
  return createMemoryAuthority({
    principal: { kind: 'run', id: run.runId },
    tenantId: run.tenantId,
    ownerId: run.ownerId,
    purpose: options.purpose ?? 'conversation-memory',
    capabilities: granted,
    policyRevision: requestContext.authority.authorizationRevision,
    projection: 'bureau',
    delegatedBy: [
      { principal: { kind: 'service', id: 'bureau' }, capabilities: deployment },
      {
        principal: memoryPrincipalFor(requestContext.authority.principalId),
        capabilities: granted,
      },
    ],
  });
}
/** Builds the authority a listed memory tool uses for one call. */
export function createToolMemoryAuthority(
  requestContext: ToolRequestContext,
  toolName: string,
  options: BureauMemoryAuthorityOptions = {},
  identity?: Pick<MemoryAuthority, 'tenantId' | 'ownerId'>,
): MemoryAuthority {
  const deployment = options.toolCapabilities ?? DEFAULT_TOOL_MEMORY_CAPABILITIES;
  const known = new Set<string>(MEMORY_CAPABILITIES);
  const requested = requestContext.authority.capabilities.filter((capability) =>
    known.has(capability),
  );
  const ceiling =
    requested.length === 0
      ? deployment
      : deployment.filter((capability) => requested.includes(capability));
  const required = Object.hasOwn(MEMORY_TOOL_CAPABILITIES, toolName)
    ? (MEMORY_TOOL_CAPABILITIES[toolName] ?? [])
    : [];
  const granted = ceiling.filter((capability) => required.includes(capability));
  return createMemoryAuthority({
    principal: { kind: 'tool', id: toolName },
    tenantId: identity?.tenantId ?? requestContext.authority.tenantId,
    ownerId: identity?.ownerId ?? requestContext.authority.ownerId,
    purpose: 'tool',
    capabilities: granted,
    policyRevision: requestContext.authority.authorizationRevision,
    projection: 'tool',
    delegatedBy: [
      {
        principal: memoryPrincipalFor(requestContext.authority.principalId),
        capabilities: granted,
      },
    ],
  });
}
/** The authorization revision of Bureau's own maintenance authority, recorded on what a sweep writes. */
export const BUREAU_MAINTENANCE_POLICY_REVISION = 'bureau:maintenance';
/** The only capabilities Bureau's maintenance authority holds: a retention sweep and the deletions it opens. */
export const BUREAU_MAINTENANCE_MEMORY_CAPABILITIES: readonly MemoryCapability[] = Object.freeze([
  'memory:retention',
  'memory:delete',
]);
/**
 * COR-1629 — the authority Bureau's maintenance pass sweeps governed memory's retention under: a
 * one-link `service:bureau` chain, the principal every run chain starts from, holding exactly the
 * two capabilities a sweep needs. The sweep walks every scope of the tenant, so `ownerId` only
 * names who acted. No run authority gains a capability from it. A Bureau without governed memory
 * has nothing to sweep, so it gets no authority.
 */
export function createMaintenanceMemoryAuthority(
  memory: GovernedMemory | undefined,
  tenantId: string,
): MemoryAuthority | undefined {
  if (memory === undefined) return undefined;
  return createMemoryAuthority({
    principal: { kind: 'service', id: 'bureau' },
    tenantId,
    ownerId: tenantId,
    purpose: 'retention',
    capabilities: BUREAU_MAINTENANCE_MEMORY_CAPABILITIES,
    policyRevision: BUREAU_MAINTENANCE_POLICY_REVISION,
    projection: 'bureau',
  });
}
/**
 * The memory principal behind a request authority's `principalId`. Memory
 * classifies a `service:` identity as a service, but Bureau's own service
 * principals (`system:scheduler`) live in the reserved `system:` namespace, so
 * they are named here rather than read as users.
 */
function memoryPrincipalFor(principalId: string) {
  return principalId.startsWith('system:')
    ? ({ kind: 'service', id: principalId } as const)
    : requestPrincipal(principalId);
}
/** What a withdrawn evidence row reads as once a newer bundle replaced it. */
const WITHDRAWN_MEMORY_EVIDENCE = '[memory evidence withdrawn: the memory policy changed]';
function appendMemoryEvidence(
  conversation: Conversation,
  target: RunMemoryTarget,
  bundle: MemoryEvidenceBundle,
): void {
  if (bundle.evidence.length === 0) {
    return;
  }
  // The bundle's identity rides on the row it renders into: Operative's epoch
  // sealer reads `bundleRevision` and `contentDigest` here and checks the
  // digest against the row, so the epoch names exactly the bundle the model
  // sees (COR-771).
  conversation.appendSystemMessage(bundle.rendered, {
    [MEMORY_EVIDENCE_METADATA_KEY]: {
      sessionId: target.sessionId,
      recordIds: bundle.evidence.map((item) => item.id),
      withheld: bundle.withheld,
      bundleRevision: bundle.revision,
      contentDigest: bundle.contentDigest,
      policyRevision: bundle.policyRevision,
    },
  });
}
/** Positions of the evidence rows recalled under a memory policy that is no longer in force. */
function staleEvidencePositions(conversation: Conversation, policyRevision: string): number[] {
  const { ids, messages } = conversation.current;
  return ids.flatMap((id, position) => {
    const entry = getOwn(messages, id)?.metadata?.[MEMORY_EVIDENCE_METADATA_KEY];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const recalledUnder = (entry as Record<string, unknown>)['policyRevision'];
    if (typeof recalledUnder !== 'string' || recalledUnder === policyRevision) return [];
    return getOwn(messages, id)?.content === WITHDRAWN_MEMORY_EVIDENCE ? [] : [position];
  });
}
/**
 * Inject recalled memory on step 0 through governed memory's mandatory recall
 * admission (COR-41). Only records the run's authority may search, whose trust
 * meets the policy minimum for their class, and that pass the recall detectors
 * reach the conversation, and they arrive inside a labeled evidence envelope
 * whose content cannot close the envelope or claim authority. A record a
 * detector trips on is quarantined instead.
 *
 * A bundle never outlives the memory policy it was recalled under (COR-771).
 * On every step, including step 0 of a session's next run and the first step
 * of a recovered run, an evidence row recalled under an older policy revision
 * is withdrawn and the prompt is recalled again, so the next epoch records the new bundle rather
 * than carrying the stale one as current. Compaction and steering never
 * recall: a compaction that rewrites the row breaks its digest, which the
 * epoch flags, and steering does not change what memory returns.
 *
 * Replay classification (seam #11): `effectful`, because recall admission
 * writes to the governance ledger and can quarantine a poisoned record. Both
 * effects are idempotent under a recovery re-fire: the durable workflow
 * rehydrates a fresh `Conversation.from(snapshot)` per step, so the re-fire
 * re-injects into that step's conversation, a record quarantined the first
 * time is simply absent the second, and the ledger records the second recall
 * that genuinely happened.
 */
export function createMemoryRecallHook(
  memory: GovernedMemory,
  authority: MemoryAuthority,
  target: RunMemoryTarget,
  onDetection?: (detection: MemoryRecallDetection, step: number) => void | Promise<void>,
): PrepareStepHook {
  return async (context) => {
    // The current prompt, whatever its shape: a string, or the text parts of a
    // part array (COR-716). Recall never runs against an older message because
    // the current one carries media, and a prompt with no text recalls nothing.
    const messages = context.conversation.getMessages();
    const latestUserMessage = messages.findLast((message) => message.role === 'user');
    const query = latestUserMessage === undefined ? '' : messageText(latestUserMessage);

    // Stale rows are withdrawn on every step, step 0 included: a session's
    // next run starts at step 0 with the rows its earlier runs recalled.
    const withdrawStale = (): number => {
      const stale = staleEvidencePositions(context.conversation, memory.policyRevision);
      for (const position of stale) {
        context.conversation.redactMessageAtPosition(position, WITHDRAWN_MEMORY_EVIDENCE);
      }
      return stale.length;
    };
    if (withdrawStale() === 0 && context.step !== 0) {
      return;
    }

    if (query.trim() === '') {
      return;
    }

    const recall = () =>
      memory.recallForModel(authority, query, {
        collection: target.collection,
        limit: 5,
        contextId: authority.principal.id,
      });
    // A policy change that lands while recall runs leaves the bundle admitted
    // under the old policy, so it is recalled once more; if the policy moves
    // again, nothing is appended rather than evidence no current policy admitted.
    // Every recall's detections are reported, including one the policy change below discards: the
    // content was read, and a detector flagged it.
    const recallReporting = async () => {
      const recalled = await recall();
      for (const { detection } of recalled.exclusions) {
        if (detection !== undefined) await onDetection?.(detection, context.step);
      }
      return recalled;
    };
    let bundle = await recallReporting();
    if (bundle.policyRevision !== memory.policyRevision) bundle = await recallReporting();
    // The scan above ran under the policy recall started with; rows it kept
    // may be stale under the one in force now, so scan again either way.
    withdrawStale();
    if (bundle.policyRevision !== memory.policyRevision) return;
    appendMemoryEvidence(context.conversation, target, bundle);
  };
}
/**
 * Persist the final assistant content of a step as governed memory (COR-41).
 * Assistant output is ordinary conversation, so it is admitted as an untrusted
 * `conversation` write under the run's memory authority: it is scanned, quota
 * checked, and quarantined when poisoned, and its record carries the run's full
 * attribution. A refused or quarantined write is recorded in the governance
 * ledger, not surfaced to the run.
 *
 * EFFECTFUL hook (seam #11): a step can run more than once, so this hook can
 * fire AGAIN for the same step. A durable recovery re-runs the crashed in-flight
 * step from its boundary, and a requeued run either resumes from its
 * last completed step (durable engine) or starts again (no engine). The
 * mitigation is IDEMPOTENCY, not suppression-on-replay — suppressing the hook
 * would drop the write for a step whose work (generate + tools) did re-execute,
 * leaving memory out of sync with a step that ran.
 *
 * Idempotency is enforced by a DETERMINISTIC operation key, not by content: a
 * replayed step may produce non-byte-identical content (its `generate` re-runs).
 * The write uses a stable `dedupeKey` of `${runId}:${step}` (the operation's
 * identity — same run, same step index across a replay), so a re-fire is an
 * atomic no-op regardless of content drift.
 *
 * Every run Bureau composes passes a `runId`: the run id for `createRun` runs,
 * schedule fires, and recovered runs. Without a `runId` the write carries no dedupe key and a repeated step
 * stores its answer again, so omit it only for a step that cannot run twice.
 *
 * `replay: 'effectful'` ({@link HookReplayPolicy}) is recorded on the write for
 * diagnostics; it documents the contract and never gates execution.
 */
export function createMemoryPersistHook(
  memory: GovernedMemory,
  authority: MemoryAuthority,
  target: RunMemoryTarget,
  runId?: string,
  /**
   * Told of a write governed memory rejected (a quota, a content rule, a missing capability), which
   * stores no record and so leaves nothing else to say the answer was not remembered (COR-1546).
   * Receives the receipt, which names a reason and never the content.
   */
  onRejected?: (receipt: MemoryWriteReceipt) => void,
): OnStepHook {
  return async (context) => {
    if (!context.final || !context.content.trim()) {
      return;
    }

    // Deterministic identity of THIS durable operation: same run + same step
    // index on a replay. Content-independent, so a divergent regenerate cannot
    // produce a second record.
    const dedupeKey = runId === undefined ? undefined : `${runId}:${context.step}`;

    const receipt = await memory.write(authority, context.content, {
      collection: target.collection,
      source: 'conversation',
      memoryClass: 'episodic',
      // Replay classification (seam #11): an external write → `effectful`, kept
      // safe across a recovery re-fire by the atomic dedupeKey write. Metadata
      // only; never gates execution. The collection is the agent, so no record or
      // event names the chat that produced it any more (COR-1546): `sessionId` is how
      // the Memory page shows where a memory came from.
      metadata: {
        step: context.step,
        replay: 'effectful' satisfies HookReplayPolicy,
        sessionId: target.sessionId,
      },
      ...(dedupeKey === undefined ? {} : { dedupeKey }),
      ...(runId === undefined ? {} : { runId }),
      // COR-768: every notification of this write names the run, the chat, and, when the run
      // seals effective-context epochs, the epoch of the attempt that produced the answer.
      correlation: {
        ...(runId === undefined ? {} : { runId }),
        sessionId: target.sessionId,
        ...(context.contextEpochId === undefined ? {} : { contextEpochId: context.contextEpochId }),
      },
    });
    if (receipt.status === 'rejected') onRejected?.(receipt);
  };
}
