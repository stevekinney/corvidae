import type { ProjectionReference } from './evidence-projection-schema';
import { digestOfText } from './evidence-schema';
import type { MemoryAuthority } from './governance/authority';
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
  readonly now: () => number;
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
 * new evidence; the procedure itself is never edited. A failure of a procedure
 * that is still active demotes it, by that episode, so it stays recallable at
 * lower rank and its history says why. Retiring it for good is
 * {@link retireProcedure}'s.
 */
export async function recordProcedureOutcome(
  options: RecordProcedureOutcomeOptions,
): Promise<ProcedureOutcomeRecord> {
  const { authority, engine, namespace } = options;
  const at = options.now();
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

/** Quarantines or revokes a procedure through an ordinary `revise-projection` transition. */
export async function retireProcedure(options: RetireProcedureOptions): Promise<TransitionResult> {
  const { authority } = options;
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
