import type { EvidenceProjectionRecord, ProjectionReference } from './evidence-projection-schema';
import { digestOfText } from './evidence-schema';
import type { MemoryAuthority } from './governance/authority';
import { decideMemoryAccess } from './governance/predicate';
import type { TransitionEngine } from './transition-engine';
import type { TransitionResult } from './transition-outcome';

function committed(result: TransitionResult): boolean {
  return result.outcome === 'committed';
}

/** One application's outcome, for {@link recordProcedureOutcome}. */
export interface RecordProcedureOutcomeOptions {
  readonly engine: TransitionEngine;
  readonly authority: MemoryAuthority;
  readonly namespace: string;
  /** The procedure revision that was applied. */
  readonly procedure: ProjectionReference;
  readonly operationId: string;
  /** The id of the episode projection the outcome is recorded as. */
  readonly episodeId: string;
  readonly outcome: 'succeeded' | 'failed';
  /** What happened, in a sentence; the episode's summary. */
  readonly summary: string;
  /** For a failure, its signature, recorded with the outcome. */
  readonly failureSignature?: string;
  readonly runId?: string;
  readonly projectorRevision: string;
  /**
   * When the application ended. It is part of what is recorded, not the time of
   * recording, so a retried call proposes the same transitions and replays them.
   */
  readonly at: number;
}

/** What recording an outcome wrote: the episode, and whether it demoted the procedure. */
export interface ProcedureOutcomeRecord {
  readonly episode: ProjectionReference;
  readonly demoted: boolean;
  readonly results: readonly TransitionResult[];
}

/** Thrown when one of an outcome's transitions is refused; `result` says why. */
export class ProcedureLifecycleError extends Error {
  constructor(readonly result: TransitionResult) {
    super(`A procedure lifecycle transition ended ${result.outcome}.`);
    this.name = 'ProcedureLifecycleError';
  }
}

/** Every lifecycle helper acts on procedures only; any other projection is refused before a write. */
async function assertProcedure(
  engine: TransitionEngine,
  tenantId: string,
  namespace: string,
  procedure: ProjectionReference,
): Promise<EvidenceProjectionRecord> {
  const target = await engine.storage.getProjectionRevision(
    tenantId,
    namespace,
    procedure.id,
    procedure.revision,
  );
  if (target?.kind !== 'procedure') {
    throw new ProcedureLifecycleError({
      outcome: 'rejected',
      reason: 'projection-not-found',
      detail: `${namespace}/${procedure.id}@${procedure.revision} is not a procedure revision.`,
    });
  }
  return target;
}

/**
 * Refuses an outcome for a procedure the authority could not write, before
 * anything is written: one resting on evidence another owner keeps private reads
 * as not found, so recording outcomes cannot probe for it or claim to have run it.
 */
async function assertWritable(
  engine: TransitionEngine,
  authority: MemoryAuthority,
  namespace: string,
  target: EvidenceProjectionRecord,
): Promise<void> {
  for (const source of target.sources) {
    const evidence = await engine.storage.getEvidence(authority.tenantId, source.evidenceId);
    const allowed =
      evidence !== undefined &&
      decideMemoryAccess(authority, 'write', {
        tenantId: evidence.tenantId,
        ownerId: evidence.ownerId,
        visibility: evidence.authorizationScope.visibility,
        sharedWith: evidence.authorizationScope.sharedWith,
        state: 'active',
        integrity: 'intact',
        pendingDerivation: false,
      }).allowed;
    if (!allowed) {
      throw new ProcedureLifecycleError({
        outcome: 'rejected',
        reason: 'projection-not-found',
        detail: `${namespace}/${target.id}@${target.revision} is not a procedure revision.`,
      });
    }
  }
}

async function submitAll(
  engine: TransitionEngine,
  proposals: Parameters<TransitionEngine['submit']>[0][],
): Promise<TransitionResult[]> {
  const results: TransitionResult[] = [];
  for (const proposal of proposals) {
    const result = await engine.submit(proposal);
    if (!committed(result)) throw new ProcedureLifecycleError(result);
    results.push(result);
  }
  return results;
}

/**
 * Feeds an application's outcome back into memory as a new episode resting on
 * new evidence; the procedure itself is never edited. The evidence, the
 * episode, and a demotion are separate transitions on purpose: the first two
 * are facts about what happened and stay true whether or not the demotion
 * lands, and each replays on retry. A failure of a procedure
 * that is still active demotes it, by that episode, so it stays recallable at
 * lower rank and its history says why. Retiring it for good is
 * {@link retireProcedure}'s.
 */
export async function recordProcedureOutcome(
  options: RecordProcedureOutcomeOptions,
): Promise<ProcedureOutcomeRecord> {
  const { authority, engine, namespace } = options;
  const { at } = options;
  const target = await assertProcedure(engine, authority.tenantId, namespace, options.procedure);
  await assertWritable(engine, authority, namespace, target);
  // An application cannot end before the revision it applied existed; nothing is written for one that claims to.
  if (at < target.transition.at) {
    throw new ProcedureLifecycleError({
      outcome: 'rejected',
      reason: 'temporal-inconsistency',
      detail: `The outcome at ${at} precedes ${namespace}/${options.procedure.id}@${options.procedure.revision} (${target.transition.at}).`,
    });
  }
  const text = JSON.stringify({
    procedure: `${namespace}/${options.procedure.id}@${options.procedure.revision}`,
    outcome: options.outcome,
    summary: options.summary,
    ...(options.failureSignature === undefined
      ? {}
      : { failureSignature: options.failureSignature }),
  });
  const evidenceId = `${options.operationId}:outcome`;
  const digest = digestOfText(text);
  const base = { tenantId: authority.tenantId, authority };
  const proposals: Parameters<TransitionEngine['submit']>[0][] = [
    {
      ...base,
      operationId: `${options.operationId}:evidence`,
      kind: 'append-evidence',
      evidence: [
        {
          schemaVersion: 1,
          id: evidenceId,
          tenantId: authority.tenantId,
          ownerId: authority.ownerId,
          kind: 'tool-result',
          sourceLocator: `procedure-outcome:${namespace}/${options.procedure.id}`,
          content: { kind: 'inline', text },
          digest,
          producer: { kind: authority.principal.kind, id: authority.principal.id },
          principal: authority.principal,
          trustTier: 'untrusted',
          eventAt: at,
          observedAt: at,
          classification: 'internal',
          authorizationScope: { visibility: 'private', sharedWith: [] },
          retention: { kind: 'source-linked' },
          ...(options.runId === undefined ? {} : { causation: { runId: options.runId } }),
        },
      ],
    },
    {
      ...base,
      operationId: `${options.operationId}:episode`,
      kind: 'create-projection',
      projections: [
        {
          id: options.episodeId,
          tenantId: authority.tenantId,
          namespace,
          kind: 'episode',
          projectorRevision: options.projectorRevision,
          sources: [{ evidenceId, digest }],
          confidence: 1,
          payload: { summary: options.summary, occurredFrom: at },
          validity: { validFrom: at },
        },
      ],
    },
  ];
  const current = await engine.storage.getProjection(
    authority.tenantId,
    namespace,
    options.procedure.id,
  );
  const demote =
    options.outcome === 'failed' &&
    current?.revision === options.procedure.revision &&
    current.status === 'active';
  const episode = { id: options.episodeId, revision: 1 };
  if (demote) {
    proposals.push({
      ...base,
      operationId: options.operationId,
      kind: 'revise-projection',
      revisions: [
        {
          namespace,
          id: options.procedure.id,
          expectedRevision: options.procedure.revision,
          change: { kind: 'demoted', demotedBy: episode },
        },
      ],
    });
  }
  return { episode, demoted: demote, results: await submitAll(engine, proposals) };
}

/** Which procedure revision to quarantine or revoke, and why, for {@link retireProcedure}. */
export interface RetireProcedureOptions {
  readonly engine: TransitionEngine;
  /** Needs `memory:revoke`. */
  readonly authority: MemoryAuthority;
  readonly namespace: string;
  readonly procedure: ProjectionReference;
  readonly operationId: string;
  /**
   * `quarantine` takes a suspect procedure out of use pending investigation;
   * `revoke` retires one known to be wrong. Both end it as a `revoked`
   * revision, which nothing can make recallable again; the reason code says
   * which, as `quarantined:<reason>` or `revoked:<reason>`.
   */
  readonly change: 'quarantine' | 'revoke';
  readonly reason: string;
}

/**
 * Quarantines or revokes a procedure through an ordinary `revise-projection`
 * transition. Throws {@link ProcedureLifecycleError} when the reference names
 * anything but a procedure revision, before anything is written.
 */
export async function retireProcedure(options: RetireProcedureOptions): Promise<TransitionResult> {
  const { authority } = options;
  await assertProcedure(options.engine, authority.tenantId, options.namespace, options.procedure);
  const prefix = options.change === 'quarantine' ? 'quarantined' : 'revoked';
  return options.engine.submit({
    kind: 'revise-projection',
    operationId: options.operationId,
    tenantId: authority.tenantId,
    authority,
    revisions: [
      {
        namespace: options.namespace,
        id: options.procedure.id,
        expectedRevision: options.procedure.revision,
        change: { kind: 'revoked', reasonCode: `${prefix}:${options.reason}` },
      },
    ],
  });
}
