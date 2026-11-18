/**
 * COR-2429 — whether a run may proceed on an agent a person disabled. The one rule: a disabled
 * agent starts nothing new, and a run that this Bureau admitted while the agent was enabled
 * finishes. That is decided here and nowhere else, from typed evidence a durable record holds,
 * never from a flag a caller sets or from what a request or a conversation looks like.
 *
 * Every path that resolves an agent for a run passes the evidence it has (or none) on the
 * definition it records ({@link StartedRunEvidence}), and the agent resolver asks
 * {@link admitsRunOnDisabledAgent}. Evidence a path can give:
 *
 * - `gated-durable-run`: the durable workflow of a catalog run or a session run, which dispatch and
 *   run creation make only after they asked the gate, for this run.
 * - `scheduled-fire`: what a fire's first attempt left once it got going (the definition reference
 *   it recorded, or its run id in its session's metadata); a fire's first attempt has neither, and
 *   its workflow is the scheduler's, made without the gate, so it is no evidence.
 * - `review-continuation`: the run that answers a chat's decided tool approvals. Its command id
 *   names the run that parked on them (`review-continuation:<chat>:<run>`), and a decided approval
 *   of that run in this chat must be on record. The command id makes it one run: the run-creation
 *   ledger answers every later start under it with the run it already started.
 *
 * `agent-disabled-start-paths.test.ts` lists every place evidence is given.
 *
 * @module disabled-agent-admission
 */

import type { ResolvedReview } from './bureau-types/reviews';

/** What durable record says that this run was admitted while its agent was enabled. */
export type StartedRunEvidence =
  | {
      /**
       * A catalog run or a session run being resumed: its durable workflow, which only dispatch or
       * run creation makes, each after asking the gate.
       */
      readonly kind: 'gated-durable-run';
      readonly runId: string;
    }
  | {
      readonly kind: 'scheduled-fire';
      readonly runId: string;
      /** The run whose definition reference the fire's first attempt recorded, if it did. */
      readonly referenceRunId: string | undefined;
      /** The fire run its session last recorded (`lastScheduledFireRunId`), if any. */
      readonly sessionFireRunId: unknown;
    }
  | {
      readonly kind: 'review-continuation';
      /** The chat the run starts on. */
      readonly sessionId: string;
      /** The run-creation command id the start carries, if any. */
      readonly commandId: string | undefined;
      /** Whether the start brings a message, parts or rows of its own: a continuation brings none. */
      readonly bringsInput: boolean;
    };

/** What the decision reads from durable state. */
export interface DisabledAgentAdmissionReads {
  /** Whether the durable engine holds a workflow `runId`. */
  readonly durableRunExists: (runId: string) => Promise<boolean>;
  /** The decided reviews on record; `undefined` while the Bureau cannot read them. */
  readonly decidedReviews: (() => Promise<readonly ResolvedReview[]>) | undefined;
}

const CONTINUATION_PREFIX = 'review-continuation:';

/**
 * The decided run a continuation's command id names in chat `sessionId`, or `undefined` when the
 * command id is not a continuation's of that chat.
 */
function continuedRunOf(commandId: string | undefined, sessionId: string): string | undefined {
  const prefix = `${CONTINUATION_PREFIX}${sessionId}:`;
  if (commandId === undefined || !commandId.startsWith(prefix)) return undefined;
  const runId = commandId.slice(prefix.length);
  return runId === '' ? undefined : runId;
}

/**
 * Whether a run with `evidence` may proceed on an agent a person disabled: only when the evidence
 * is a durable record that this very run was admitted while the agent was enabled. No evidence is
 * a new run, which a disabled agent never starts.
 */
export async function admitsRunOnDisabledAgent(
  evidence: StartedRunEvidence | undefined,
  reads: DisabledAgentAdmissionReads,
): Promise<boolean> {
  if (evidence === undefined) return false;
  switch (evidence.kind) {
    case 'gated-durable-run':
      return evidence.runId !== '' && (await reads.durableRunExists(evidence.runId));
    case 'scheduled-fire':
      return (
        evidence.runId !== '' &&
        (evidence.referenceRunId === evidence.runId || evidence.sessionFireRunId === evidence.runId)
      );
    case 'review-continuation': {
      if (evidence.bringsInput || reads.decidedReviews === undefined) return false;
      const parkedRunId = continuedRunOf(evidence.commandId, evidence.sessionId);
      if (parkedRunId === undefined) return false;
      const decided = await reads.decidedReviews();
      return decided.some(
        ({ review }) =>
          review.kind === 'tool-approval' &&
          review.runId === parkedRunId &&
          review.sessionId === evidence.sessionId,
      );
    }
  }
}
