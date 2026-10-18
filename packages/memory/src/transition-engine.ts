import type {
  EvidenceProjectionCommitResult,
  EvidenceProjectionStorage,
} from './evidence-projection-storage';
import { MemoryEvidenceValidationError } from './evidence-schema';
import type {
  TransitionEvent,
  TransitionEventSink,
  TransitionSourceReference,
} from './transition-events';
import { classifyStoreError, type TransitionResult } from './transition-outcome';
import { plannedProjections, type TransitionPlan } from './transition-plan';
import {
  digestOfParsedProposal,
  parseTransitionProposal,
  type TransitionProposal,
} from './transition-proposal';
import { createTransitionReader, type TransitionReader } from './transition-reader';
import {
  createTransitionKeys,
  decodeTransitionReceipt,
  DEFAULT_TRANSITION_KEY_PREFIX,
  encodeTransitionReceipt,
  type TransitionReceipt,
} from './transition-receipt';
import {
  buildReceipt,
  predictOutcomes,
  type PredictedOutcomes,
} from './transition-receipt-builder';
import { validateTransition } from './transition-validator';

export interface TransitionEngineHookContext {
  readonly operationId: string;
  readonly tenantId: string;
}

export type TransitionEngineHook = (context: TransitionEngineHookContext) => void | Promise<void>;

export interface CreateTransitionEngineOptions {
  readonly storage: EvidenceProjectionStorage;
  readonly sink: TransitionEventSink;
  /** The clock. A submission reads it twice, or once when it finds an existing receipt. */
  readonly now: () => number;
  /** Defaults to `DEFAULT_TRANSITION_KEY_PREFIX`; a caller with custom storage prefixes keeps them disjoint. */
  readonly receiptKeyPrefix?: string;
  /**
   * Test-only barriers at the engine's own write boundaries. The store's batch
   * boundary is `wrapApply` on the storage factory, not here. A fixture abandons
   * work by never resolving a hook. A hook that throws is treated as a throw from
   * the batch call. Production code never sets one.
   */
  readonly hooks?: {
    /** After the stale check, before `commit()`. */
    readonly beforeBatch?: TransitionEngineHook;
    /** After `commit()` resolves, before the receipt read-back. */
    readonly afterBatch?: TransitionEngineHook;
    /** After the read-back, before the `committed` and `superseded` events. */
    readonly beforeEvents?: TransitionEngineHook;
  };
}

export interface SubmitTransitionOptions {
  /** Aborting before the batch call ends the submission as `canceled`; after it, the commit stands. */
  readonly signal?: AbortSignal;
}

export interface TransitionEngine {
  /**
   * Validates a proposal and applies it atomically with its receipt. Throws
   * {@link MemoryTransitionProposalError} for a proposal that fails its schema
   * and {@link TransitionIdentifierConflictError} for an operation id already
   * used with a different proposal; every other submission ends in one of the
   * five outcomes.
   */
  submit(
    proposal: TransitionProposal,
    options?: SubmitTransitionOptions,
  ): Promise<TransitionResult>;
  /** The committed receipt for an operation id, or `undefined`. Tenant-scoped by key. */
  getReceipt(tenantId: string, operationId: string): Promise<TransitionReceipt | undefined>;
}

/** An operation id was reused with a proposal whose digest differs from the stored receipt's. */
export class TransitionIdentifierConflictError extends Error {
  readonly code = 'operation-id-conflict';

  constructor(
    readonly tenantId: string,
    readonly operationId: string,
    readonly storedDigest: string,
    readonly submittedDigest: string,
  ) {
    super(
      `Operation "${operationId}" already committed a different proposal (${storedDigest}); this one is ${submittedDigest}.`,
    );
    this.name = 'TransitionIdentifierConflictError';
  }
}

/** The commit applied, but not in the way its receipt says it would. */
class TransitionReceiptMismatchError extends Error {
  readonly code = 'receipt-mismatch';

  constructor(detail: string) {
    super(detail);
    this.name = 'TransitionReceiptMismatchError';
  }
}

const textDecoder = new TextDecoder();

function decodeStoredReceipt(bytes: Uint8Array, tenantId: string, operationId: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(textDecoder.decode(bytes));
  } catch {
    throw new MemoryEvidenceValidationError(
      'malformed',
      'receipt',
      'A stored receipt is not JSON.',
    );
  }
  const receipt = decodeTransitionReceipt(raw, { tenantId });
  if (receipt.operationId !== operationId) {
    throw new MemoryEvidenceValidationError(
      'malformed',
      'receipt',
      `A receipt stored under "${operationId}" says it is "${receipt.operationId}".`,
    );
  }
  return receipt;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** The references a `requested` event lists: every record the proposal touches, ids and digests only. */
async function requestedSources(
  proposal: TransitionProposal,
  reader: TransitionReader,
): Promise<TransitionSourceReference[]> {
  const sources: TransitionSourceReference[] = [];
  const evidence = (id: string, digest: string) => sources.push({ kind: 'evidence', id, digest });
  const projection = (namespace: string, id: string, revision: number) =>
    sources.push({ kind: 'projection', namespace, id, revision });
  const predecessors = async (ids: readonly string[]) => {
    for (const id of ids) {
      // A predecessor that cannot be read is left out; validation names it in the refusal.
      const stored = await reader.evidence(id).catch(() => undefined);
      if (stored !== undefined) evidence(id, stored.digest);
    }
  };
  switch (proposal.kind) {
    case 'append-evidence':
      for (const record of proposal.evidence) evidence(record.id, record.digest);
      break;
    case 'correct-evidence':
      evidence(proposal.successor.id, proposal.successor.digest);
      await predecessors(proposal.successor.supersedes ?? []);
      break;
    case 'consolidate':
      for (const candidate of proposal.candidates) {
        projection(proposal.namespace, candidate.id, candidate.revision);
      }
      projection(proposal.namespace, proposal.summary.id, 1);
      break;
    default:
      break;
  }
  if (proposal.kind === 'create-projection' || proposal.kind === 'correct-evidence') {
    for (const created of proposal.projections ?? []) projection(created.namespace, created.id, 1);
  }
  if (proposal.kind === 'revise-projection' || proposal.kind === 'correct-evidence') {
    for (const revision of proposal.revisions ?? []) {
      projection(revision.namespace, revision.id, revision.expectedRevision);
    }
  }
  return sources;
}

export function createTransitionEngine(options: CreateTransitionEngineOptions): TransitionEngine {
  const { storage, sink, now, hooks } = options;
  const keys = createTransitionKeys(options.receiptKeyPrefix ?? DEFAULT_TRANSITION_KEY_PREFIX);

  async function readReceipt(
    tenantId: string,
    operationId: string,
  ): Promise<TransitionReceipt | undefined> {
    const bytes = await storage.getReceipt(keys.receipt(tenantId, operationId));
    return bytes === null ? undefined : decodeStoredReceipt(bytes, tenantId, operationId);
  }

  async function submit(
    raw: TransitionProposal,
    submitOptions?: SubmitTransitionOptions,
  ): Promise<TransitionResult> {
    const proposal = parseTransitionProposal(raw);
    const digest = digestOfParsedProposal(proposal);
    const { tenantId, operationId, authority } = proposal;
    const signal = submitOptions?.signal;
    const requestedAt = now();
    const reader = createTransitionReader(storage, tenantId);
    let eventAt = requestedAt;

    /** Delivers one event. A sink that throws never changes the outcome or the sequence. */
    async function emit(
      event: { kind: TransitionEvent['kind'] } & Record<string, unknown>,
    ): Promise<void> {
      try {
        await sink({
          operationId,
          tenantId,
          proposalKind: proposal.kind,
          principal: { kind: authority.principal.kind, id: authority.principal.id },
          ownerId: authority.ownerId,
          at: eventAt,
          ...event,
        } as TransitionEvent);
      } catch {
        // The sink observes; it does not decide.
      }
    }

    async function committedFrom(
      receipt: TransitionReceipt,
      replayed: boolean,
    ): Promise<TransitionResult> {
      await emit({ kind: 'recovery-reconciled', digest });
      return { outcome: 'committed', receipt, replayed };
    }

    /** An existing receipt settles the submission: the same digest replays it, any other digest is a reused id. */
    async function settleAgainst(receipt: TransitionReceipt): Promise<TransitionResult> {
      if (receipt.digest === digest) return committedFrom(receipt, true);
      throw new TransitionIdentifierConflictError(tenantId, operationId, receipt.digest, digest);
    }

    async function runHook(
      hook: ((context: TransitionEngineHookContext) => void | Promise<void>) | undefined,
    ) {
      await hook?.({ operationId, tenantId });
    }

    /**
     * A throw from the batch call, or from a boundary after it. The receipt is
     * re-read before any error is mapped: if this proposal's receipt exists the
     * batch landed, whoever applied it.
     */
    async function afterFailure(error: unknown): Promise<TransitionResult> {
      let stored: TransitionReceipt | undefined;
      try {
        stored = await readReceipt(tenantId, operationId);
      } catch (readError) {
        return unknown(readError);
      }
      if (stored !== undefined) return settleAgainst(stored);
      const classified = classifyStoreError(error);
      if (classified?.outcome === 'rejected') {
        await emit({ kind: 'rejected', reason: classified.reason, detail: classified.detail });
        return classified;
      }
      if (classified?.outcome === 'conflicted') {
        await emit({ kind: 'conflicted', reason: classified.reason, detail: classified.detail });
        return classified;
      }
      return unknown(error);
    }

    async function unknown(error: unknown): Promise<TransitionResult> {
      const name = error instanceof Error ? error.name : 'Error';
      const code =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : undefined;
      await emit({ kind: 'failed', error: { name, ...(code === undefined ? {} : { code }) } });
      return { outcome: 'unknown', error };
    }

    async function canceled(): Promise<TransitionResult> {
      await emit({ kind: 'canceled' });
      return { outcome: 'canceled' };
    }

    /** Applies the batch. Resolves to the commit's report, or to the result that ends the submission. */
    async function apply(
      plan: TransitionPlan,
      receiptBytes: Uint8Array,
    ): Promise<{ done: TransitionResult } | { report: EvidenceProjectionCommitResult }> {
      try {
        await runHook(hooks?.beforeBatch);
        if (signal?.aborted === true) return { done: await canceled() };
        const report = await storage.commit({
          tenantId,
          evidence: plan.evidence,
          projections: plannedProjections(plan),
          receipt: { key: keys.receipt(tenantId, operationId), value: receiptBytes },
        });
        await runHook(hooks?.afterBatch);
        return { report };
      } catch (error) {
        return { done: await afterFailure(error) };
      }
    }

    try {
      await emit({
        kind: 'requested',
        digest,
        sources: await requestedSources(proposal, reader),
      });

      const existing = await readReceipt(tenantId, operationId);
      if (existing !== undefined) return await settleAgainst(existing);

      await emit({ kind: 'validation-started' });
      const committedAt = now();
      eventAt = committedAt;

      const validation = await validateTransition({ proposal, reader, at: committedAt });
      if (!validation.ok) {
        await emit({ kind: 'rejected', reason: validation.reason, detail: validation.detail });
        return { outcome: 'rejected', reason: validation.reason, detail: validation.detail };
      }
      const { plan } = validation;
      const stale = plan.revisions.flatMap((revision) =>
        revision.stale === undefined ? [] : [revision.stale],
      );
      if (stale.length > 0) {
        const detail = stale.join(' ');
        await emit({ kind: 'conflicted', reason: 'stale-revision', detail });
        return { outcome: 'conflicted', reason: 'stale-revision', detail };
      }

      const predicted: PredictedOutcomes = await predictOutcomes(plan, reader);
      const receipt = buildReceipt({
        proposal,
        plan,
        digest,
        checks: validation.checks,
        predicted,
        requestedAt,
        committedAt,
      });
      const receiptBytes = encodeTransitionReceipt(receipt);

      if (signal?.aborted === true) return await canceled();
      const applied = await apply(plan, receiptBytes);
      if ('done' in applied) return applied.done;

      const reported = [...applied.report.evidence, ...applied.report.projections].map(
        (entry) => entry.outcome,
      );
      const expected = [...predicted.evidence, ...predicted.projections];
      if (reported.join() !== expected.join()) {
        throw new TransitionReceiptMismatchError(
          'The commit reported different outcomes than its receipt records.',
        );
      }
      const stored = await storage.getReceipt(keys.receipt(tenantId, operationId));
      if (stored === null || !bytesEqual(stored, receiptBytes)) {
        throw new TransitionReceiptMismatchError(
          'The stored receipt is missing or differs from the one written.',
        );
      }

      try {
        await runHook(hooks?.beforeEvents);
      } catch (error) {
        return await afterFailure(error);
      }
      await emitCommitted(receipt, plan);
      return { outcome: 'committed', receipt, replayed: false };
    } catch (error) {
      if (error instanceof TransitionIdentifierConflictError) throw error;
      return unknown(error);
    }

    async function emitCommitted(receipt: TransitionReceipt, plan: TransitionPlan): Promise<void> {
      await emit({
        kind: 'committed',
        evidence: receipt.evidence
          .filter((entry) => entry.outcome === 'appended')
          .map((entry) => ({ kind: 'evidence', id: entry.id, digest: entry.digest })),
        projections: receipt.projections
          .filter((entry) => entry.outcome === 'written')
          .map((entry) => ({
            kind: 'projection',
            namespace: entry.namespace,
            id: entry.id,
            revision: entry.revision,
          })),
      });
      const successor = plan.evidence[0];
      for (const id of plan.supersededEvidence) {
        const predecessor = await reader.evidence(id);
        if (predecessor === undefined || successor === undefined) continue;
        await emit({
          kind: 'superseded',
          subject: { kind: 'evidence', id, digest: predecessor.digest },
          successor: { kind: 'evidence', id: successor.id, digest: successor.digest },
        });
      }
      for (const revision of plan.revisions) {
        const transition = revision.next?.transition;
        if (transition?.kind !== 'superseded') continue;
        await emit({
          kind: 'superseded',
          subject: {
            kind: 'projection',
            namespace: revision.namespace,
            id: revision.id,
            revision: revision.expectedRevision,
          },
          successor: {
            kind: 'projection',
            namespace: revision.namespace,
            ...transition.supersededBy,
          },
        });
      }
    }
  }

  return {
    submit,
    async getReceipt(tenantId, operationId) {
      return readReceipt(tenantId, operationId);
    },
  };
}
