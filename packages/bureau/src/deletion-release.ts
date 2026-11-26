import { sha256HexSync } from '@lostgradient/cryptography';
import type { AgentSession, JSONValue } from '@lostgradient/operative';
import {
  verifyToolboxPendingApproval,
  type AnyToolbox,
  type SignedPendingToolApproval,
} from 'armorer';
import type { AgentDefinitions } from './agent-catalog';
import { canonicalJson } from './command-ledger';
import { REVIEW_AUDIT_OUTBOX_NAMESPACE, type BureauCore } from './bureau-seams/core';
import type { DeletionReleaseClaim } from './review-decision-record';

/** Fence the review decision and transfer its terminal release to the session outbox. */
export async function transferDeletionRelease<D extends AgentDefinitions>(
  core: BureauCore<D>,
  toolbox: AnyToolbox,
  review: {
    id: string;
    runId: string;
    sessionId: string;
    agentName: string | undefined;
    round: number;
    approval: SignedPendingToolApproval;
  },
): Promise<boolean> {
  const candidate = [...(core.terminalReviewReleases?.values() ?? [])].some(
    ({ plugin, release }) =>
      review.agentName === `${plugin}:${release.agent}` &&
      review.approval.toolName === release.tool &&
      review.approval.approvalBinding?.toolDefinitionRevision === release.toolRevision,
  );
  if (!candidate) return false;
  const approval = verifyToolboxPendingApproval(toolbox, review.approval);
  const binding = approval.approvalBinding;
  if (!binding || binding.runId !== review.runId || binding.agentId !== review.agentName)
    throw new Error('Deletion release approval binding does not match its review');
  let attachment:
    | {
        handler: string;
        identifier: string;
        runId: string;
        reviewId: string;
        round: number;
        toolRevision: string;
      }
    | undefined;
  for (const [handler, contribution] of core.terminalReviewReleases ?? []) {
    const release = contribution.release;
    if (
      review.agentName !== `${contribution.plugin}:${release.agent}` ||
      approval.toolName !== release.tool ||
      binding.toolDefinitionRevision !== release.toolRevision
    )
      continue;
    const identifier = release.identifier(approval.arguments);
    if (typeof identifier !== 'string' || identifier.length === 0)
      throw new Error('Invalid terminal review release identifier');
    attachment = {
      handler,
      identifier,
      runId: review.runId,
      reviewId: review.id,
      round: review.round,
      toolRevision: binding.toolDefinitionRevision,
    };
  }
  if (!attachment) throw new Error('Deletion release contribution is unavailable');
  const sessionStore = core.runtime.sessionStore;
  if (!sessionStore) throw new Error('Deletion release requires a durable session store');
  const session = await sessionStore.load(review.sessionId);
  if (!session) throw new Error('Deletion release session is unavailable');
  const release = { ...attachment, sessionId: review.sessionId, incarnation: session.incarnation };
  const digest = sha256HexSync(canonicalJson({ approval, sessionId: review.sessionId }));
  const claim = await core.reviewDecisions.claim({
    reviewId: review.id,
    round: review.round,
    decision: 'deny',
    principal: 'system:session-deletion',
    digest,
    deletionRelease: release,
  });
  if (claim.outcome === 'conflict' || claim.outcome === 'unfenced')
    throw new Error('Review decision cannot be fenced for context deletion');
  await attachDeletionRelease(core, release, digest);
  return true;
}

async function attachDeletionRelease<D extends AgentDefinitions>(
  core: BureauCore<D>,
  release: DeletionReleaseClaim,
  digest: string,
): Promise<void> {
  const sessionStore = core.runtime.sessionStore;
  if (!sessionStore) throw new Error('Deletion release requires a durable session store');
  if (!core.terminalReviewReleases?.has(release.handler))
    throw new Error('Deletion release contribution is unavailable');
  const payload = {
    runId: release.runId,
    type: 'terminal-release.deletion',
    principal: 'system:session-deletion',
    detail: {
      review: {
        id: release.reviewId,
        runId: release.runId,
        sessionId: release.sessionId,
        kind: 'tool-approval',
        status: 'revoked',
      },
      status: 'revoked',
    },
    terminalRelease: release,
  } as unknown as JSONValue;
  let alreadyAttached = false;
  const committed = await sessionStore.update(
    release.sessionId,
    (session) => {
      if (!session || session.incarnation !== release.incarnation) return undefined;
      const markers = session.metadata['terminalReleaseClaims'];
      const known =
        markers && typeof markers === 'object' && !Array.isArray(markers)
          ? (markers as Record<string, JSONValue>)
          : {};
      if (Object.hasOwn(known, release.reviewId)) {
        alreadyAttached = Reflect.get(known, release.reviewId) === digest;
        return undefined;
      }
      const overrides = session.metadata['pendingApprovalOverrides'];
      const rounds = session.metadata['pendingApprovalRounds'];
      const currentRound =
        rounds && typeof rounds === 'object' && !Array.isArray(rounds)
          ? (Reflect.get(rounds, release.reviewId) ?? 0)
          : 0;
      if (
        !overrides ||
        typeof overrides !== 'object' ||
        Array.isArray(overrides) ||
        sha256HexSync(
          canonicalJson({
            approval: Reflect.get(overrides, release.reviewId),
            sessionId: release.sessionId,
          }),
        ) !== digest ||
        currentRound !== release.round ||
        (Array.isArray(session.metadata['resolvedReviewIds']) &&
          session.metadata['resolvedReviewIds'].includes(release.reviewId))
      )
        return undefined;
      return {
        ...session,
        metadata: {
          ...session.metadata,
          terminalReleaseClaims: { ...known, [release.reviewId]: digest },
        },
      };
    },
    { outbox: [{ namespace: REVIEW_AUDIT_OUTBOX_NAMESPACE, payload }] },
  );
  if (!committed && !alreadyAttached)
    throw new Error('Pending review changed before deletion release was recorded');
}

/** Recover a claim even when the original request authority is no longer usable. */
export async function recoverDeletionReleases<D extends AgentDefinitions>(
  core: BureauCore<D>,
  session: AgentSession | undefined,
): Promise<void> {
  if (!session) return;
  const overrides = session.metadata['pendingApprovalOverrides'];
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return;
  const rounds = session.metadata['pendingApprovalRounds'];
  for (const reviewId of Object.keys(overrides)) {
    const round =
      rounds && typeof rounds === 'object' && !Array.isArray(rounds)
        ? (Reflect.get(rounds, reviewId) ?? 0)
        : 0;
    if (!Number.isSafeInteger(round) || typeof round !== 'number')
      throw new Error('Invalid approval round');
    const claim = await core.reviewDecisions.deletionRelease(reviewId, round);
    if (claim) await attachDeletionRelease(core, claim.release, claim.digest);
  }
}
