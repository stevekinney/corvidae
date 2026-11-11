import type { HumanInputSchema, PeerCallJournalEntry } from '@lostgradient/operative';
import type { PendingToolApproval, SignedPendingToolApproval, ToolExecutionResult } from 'armorer';
import type { ReviewDecisionRequest } from '../review-decision-record';

// ── Review queue (AB-20) ─────────────────────────────────────────────

/**
 * Shared review lifecycle vocabulary (AB-46) both {@link PendingToolApprovalReview}
 * and {@link PendingHumanWaitReview} report a `status` from. `reviews.list()`
 * only ever returns `'pending'` items; every other status surfaces through
 * `reviews.get(id)`'s audit-trail reconstruction or the audit trail itself.
 *
 * - `'pending'` — awaiting a decision.
 * - `'approved'` / `'denied'` — resolved via `reviews.resolve` with `decision: 'approve' | 'deny'`.
 * - `'rejected'` — resolved via `reviews.resolve` with `decision: 'reject'` (requires a reason).
 * - `'expired'` — a tool-approval review swept by the expiry pass (a schedule fire's, the maintenance pass's) past its binding's `expiresAt`.
 * - `'revoked'` — transitioned by task-retention expiry or `deleteSession` via `revokePendingApprovalsForRun`.
 * - `'canceled'` — transitioned by `tasks.cancel` via `revokePendingApprovalsForRun`.
 * - `'superseded'` — a tool-approval review whose `resumeApproval` re-gate produced a new `pendingApproval` for the same `callId`.
 */
export type ReviewStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'rejected'
  | 'expired'
  | 'revoked'
  | 'canceled'
  | 'superseded';
/**
 * A tool call parked by armorer's `needs_approval` policy decision. `approval`
 * is the exact {@link PendingToolApproval} (signed with `approvalToken` when
 * the bureau's toolbox was constructed with `approvalSecret`) that
 * `reviews.resolve` passes straight to `Toolbox.resumeApproval` on approve.
 */
export interface PendingToolApprovalReview {
  kind: 'tool-approval';
  /** Stable id for this review, e.g. `approval:<runId>:<callId>`. */
  id: string;
  runId: string;
  sessionId: string;
  agentName: string | undefined;
  approval: PendingToolApproval | SignedPendingToolApproval;
  /** Epoch-ms timestamp the tool call requested approval. */
  requestedAt: number;
  /** Milliseconds elapsed since `requestedAt`, computed at read time. */
  ageMilliseconds: number;
  /** The review's current lifecycle status (AB-46). See {@link ReviewStatus}. */
  status: ReviewStatus;
  /**
   * The supersession round (COR-855): 0 for an approval never superseded,
   * incremented each time `reviews.resolve` approves it and the policy gates the
   * resumed call again, which replaces the approval under the same id. It
   * separates one supersession's resolution from the next.
   */
  round: number;
  /**
   * COR-1717 — `true` when the approval was approved and its resolution started, but the process
   * ended before the decision committed, so the tool may or may not have run. Absent otherwise.
   * The tool is never re-run automatically: resolving the review runs the normal approval path
   * once, and an approval whose signed binding has expired follows the normal expiry path.
   */
  interrupted?: true | undefined;
  /**
   * COR-1717 — epoch-ms timestamp the interrupted resolution started. Undefined when the review
   * is not interrupted, or when the session holds the legacy marker that recorded no time.
   */
  resolutionStartedAt?: number | undefined;
}
/**
 * A durable run parked on `ctx.waitForSignal` by the `requestHumanInput` tool
 * (operative's F3 HITL primitive). `signalName` is the exact name
 * `reviews.resolve` passes to `Bureau.contexts.signal` on approve.
 */
export interface PendingHumanWaitReview {
  kind: 'human-wait';
  /** Id for this review, e.g. `human-wait:<runId>:<signalName>:<parkOrdinal>`; distinct per park, stable across restart. */
  id: string;
  runId: string;
  /**
   * The Bureau session the run belongs to. Absent only for a review of a run that has no session,
   * which is addressed by its run id; {@link Bureau.reviews.resolve} resumes it through the
   * engine by that id.
   */
  sessionId?: string | undefined;
  agentName: string | undefined;
  signalName: string;
  prompt: string | undefined;
  /**
   * The JSON Schema (2020-12) the agent's author configured for the signal, when one is: the
   * shape of the answer the wait expects. An A2A task projects it as a form.
   */
  inputSchema?: HumanInputSchema | undefined;
  /**
   * COR-1920 — the fields of the answer the schema marks secret, as JSON Pointers (`""` for the
   * answer itself). Set on a review read back from the audit trail, which keeps these and not the
   * schema, so a retry after the review closed can still tell which fields to keep out of a digest.
   */
  secretFields?: readonly string[] | undefined;
  /**
   * COR-2009 — the workflow step that asks, for the review of a workflow file's `await-signal` step
   * written with `"review": true`; absent for every other human wait. `runId` is then the
   * workflow's instance.
   */
  workflow?: WorkflowReviewOrigin | undefined;
  /** Epoch-ms timestamp the run parked. */
  requestedAt: number;
  /** Milliseconds elapsed since `requestedAt`, computed at read time. */
  ageMilliseconds: number;
  /** The review's current lifecycle status (AB-46). See {@link ReviewStatus}. */
  status: ReviewStatus;
}
/** COR-2009 — the workflow step a workflow review was asked by. */
export interface WorkflowReviewOrigin {
  /** The workflow's identifier. */
  readonly id: string;
  /** The workflow's `title`, when its file gives one. */
  readonly title?: string | undefined;
  /** The step's position in the file, counted from 1. */
  readonly step: number;
  /** The step's `title`, when it has one. */
  readonly stepTitle?: string | undefined;
}
/** A single item in the gateway's review queue (AB-20). */
export type PendingReview = PendingToolApprovalReview | PendingHumanWaitReview;
/**
 * A review that belongs to a session: every tool approval, and a human wait of a task.
 * Bureau's session code works in this type; a human wait of a run with no session lacks one.
 */
export type SessionPendingReview =
  PendingToolApprovalReview | (PendingHumanWaitReview & { readonly sessionId: string });
/**
 * COR-2292 — where a person decided a tool approval: `chat`, the chat whose run asked, or
 * `reviews`, the Reviews inbox. It is display provenance and nothing more: it confers no
 * privilege, plays no part in a decision's identity or its fences, and is absent when the caller
 * did not say (a CLI, an MCP client, a decision recorded before the field existed).
 */
export type ApprovalDecisionSurface = 'chat' | 'reviews';
export interface ResolveReviewInput {
  /** The {@link PendingReview.id} to resolve. */
  id: string;
  /**
   * `'reject'` (AB-46) is a `deny` outcome plus a REQUIRED caller-supplied
   * `reason`: `reviews.resolve` throws `BureauError('reject requires a reason',
   * 'BAD_REQUEST')` before any state change when `reason` is absent or empty,
   * for both review kinds.
   */
  decision: 'approve' | 'deny' | 'reject';
  /**
   * The authenticated principal making the decision (e.g. `api-key:<id>` or
   * `static-token`). Recorded in the audit trail for attribution — required,
   * not optional, so every resolution is attributable.
   */
  principal: string;
  /**
   * `tool-approval` approve only: override the tool call's arguments instead
   * of resuming with the originally-proposed ones. Ignored for `deny`/`reject`
   * and for `human-wait` reviews.
   */
  arguments?: unknown;
  /** `human-wait` approve only: the payload delivered with the signal. */
  payload?: unknown;
  /**
   * COR-1659 — the {@link PendingToolApprovalReview.round} the caller read. A re-gated approval
   * keeps its id and advances its round, so a caller that read round N would otherwise resolve
   * the replacement. When given, `reviews.resolve` compares it with the review's current round
   * before anything is claimed, and throws a `CONFLICT` `BureauError` (a
   * `ReviewRoundChangedError`) on a mismatch: nothing is decided, written, or audited. A human
   * wait is always at round 0. Omitted, the call is not fenced.
   */
  round?: number;
  /**
   * Optional human-readable note, recorded in the audit trail either way.
   * REQUIRED (non-empty) when `decision` is `'reject'`.
   */
  reason?: string;
  /**
   * COR-1828 — `tool-approval` approve only: also allow this tool for the rest of the chat. The
   * grant (`approvalGrants: [toolId]` on the session's metadata, COR-1950) is stored in the same commit as
   * the decision, and it ends with the chat: it is not carried into a fork, and a deleted session
   * takes it along. It only ever skips an `on-changes` ask. It never loosens a tool set to
   * `always` or `blocked`, an agent-wide always mode, or a read-only restriction, because those
   * answer `ask` or `deny` whatever the grant says (the registry hook composes by the most
   * restrictive verdict). Refused with `BAD_REQUEST`, before anything is decided, on a human wait
   * and on a `deny` or `reject`.
   */
  remember?: boolean;
  /**
   * COR-2292 — `tool-approval` only: where the person decided, when the caller knows. The first
   * committed decision keeps it (or its absence) on the outcome row, the audit entry and the
   * resolved-review record; a retry of the same decision from another surface changes none of
   * them. Omitted, the surface is unknown.
   */
  decisionSurface?: ApprovalDecisionSurface;
}
/** The durable peer-attachment marker carried by an interrupted approval. */
export interface ApprovalPeerRecovery {
  readonly version: 1;
  readonly toolDefinitionRevision: string;
  readonly durableOperationKey: string;
  readonly request: ReviewDecisionRequest;
  readonly arguments: { readonly message: string };
}
/** The callback input supplied to a trusted host adapter during approval recovery. */
export interface RecoverableStartedApprovalInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly reviewId: string;
  readonly callId: string;
  readonly toolDefinitionRevision: string;
  readonly durableOperationKey: string;
  readonly arguments: { readonly message: string };
  readonly journalEntry: PeerCallJournalEntry;
  readonly signal: AbortSignal;
}
/** A version-pinned, attach-only peer recovery adapter. */
export interface RecoverableStartedApproval {
  readonly version: 1;
  readonly attach: (
    input: RecoverableStartedApprovalInput,
  ) => Promise<ToolExecutionResult | undefined>;
}
export interface ResolveReviewResult {
  id: string;
  kind: PendingReview['kind'];
  decision: 'approve' | 'deny' | 'reject';
  /** The tool's `ToolExecutionResult` when a `tool-approval` was approved. */
  result?: unknown;
  /**
   * `tool-approval` reject only: echoes `input.reason` back so a caller
   * building the next manual run (per `create-agent.ts`'s docstring) can
   * splice it into the tool's `ToolExecutionResult`.
   */
  feedback?: string;
  /**
   * `tool-approval` approve only: `true` when the policy gated the resumed call
   * again, so the tool did not run and the review stays pending under the same
   * id with its {@link PendingToolApprovalReview.round} incremented.
   */
  superseded?: true;
  /**
   * COR-1828 — set when the input asked to `remember` the tool: `true` once the grant was stored
   * with the decision, `false` when the decision did not store it. A superseded resolution stores
   * no grant, because the tool did not run.
   */
  remembered?: boolean;
  /**
   * COR-1990 — set with {@link ResolveReviewResult.remembered}: whether the next ask for the tool in
   * this chat will be skipped, as the next call is decided now (the agent's `approvals` for the
   * tool and the chat's permission mode). `false` when `remembered` is, and `false` for a tool its
   * agent sets to `always` or `blocked`, a chat in `always` mode, and a tool a `read-only` chat
   * denies: the grant is stored for those, but they answer `ask` or `deny` whatever it says. Also
   * `false` for a code agent or a plugin agent: its toolbox belongs to the host, which the Bureau
   * does not wire the chat's grants into, so its next call asks again. A file agent is weighed by its
   * file's definition and a tried agent by the definition it was tried with.
   */
  loosened?: boolean;
}
/**
 * What {@link BureauReviews.get} adds to a review: its current `status`, and, once it has left the
 * queue, who closed it and when (COR-1828). Read from the review's resolved-review record when it
 * has one, otherwise from the chronologically-last `review.*` audit entry.
 */
export interface ReviewResolutionFields {
  /** The review's current lifecycle status. */
  status: ReviewStatus;
  /** The principal that closed it: the decider, or a `system:*` principal for an expiry, a revocation or a cancellation. */
  resolvedBy?: string;
  /** Epoch milliseconds it was closed. */
  resolvedAt?: number;
  /** The note given with the decision. */
  resolutionReason?: string;
  /** A human wait's approved answer as a digest over its reference form (see {@link ResolvedReview.answerDigest}). */
  answerDigest?: string;
  /** The references the approved answer's secret fields were stored under. */
  secretRefs?: readonly string[];
  /** COR-2292 — where a tool approval was decided, when its decision recorded it. */
  decisionSurface?: ApprovalDecisionSurface;
}
/**
 * A review once a person has decided it (COR-1828): the review as it was asked, who decided it,
 * what they decided, and when. Kept under `bureau-resolved-review:v1:` until `retention.audit`
 * retires it. A tool approval's signed token and binding are not part of it, and neither is a
 * secret answer: it holds the answer's SHA-256 over its reference form and the references the
 * answer's secret fields were stored under, never a plaintext or a digest of one.
 */
export interface ResolvedReview {
  /** The review as it was asked, with `status` set to the decision's (`approved`, `denied` or `rejected`). */
  readonly review: PendingReview & { status: ReviewStatus };
  /** What was decided. */
  readonly decision: 'approve' | 'deny' | 'reject';
  /** The principal that decided. */
  readonly decidedBy: string;
  /** Epoch milliseconds the decision was committed. */
  readonly decidedAt: number;
  /**
   * The owner of record of the review's run when it was decided, so the record stays listed for its
   * owner after the run and its session are deleted.
   */
  readonly owner: string;
  /** The note given with the decision; always present for a `reject`. */
  readonly reason?: string | undefined;
  /**
   * A human wait's approved answer: SHA-256 of its canonical JSON with every secret field reduced
   * to its `{ secretRef }`. Absent for a tool approval and for a `deny` or `reject`.
   */
  readonly answerDigest?: string | undefined;
  /** The references (`{ secretRef }`) the answer's secret fields were stored under; absent when it had none. */
  readonly secretRefs?: readonly string[] | undefined;
  /**
   * COR-2292 — where the person decided a tool approval, as the decision's caller said. Absent when
   * it did not say, and on every record written before the field existed.
   */
  readonly decisionSurface?: ApprovalDecisionSurface | undefined;
}
/**
 * The reviews of a Bureau: the queue of parked runs awaiting a human decision, and the
 * decision. A tool approval the policy gated and a `requestHumanInput` wait are both reviews.
 * `bureau.reviews.*` operations served by `createBureauHandler` delegate to these members.
 */
export interface BureauReviews {
  /**
   * List every parked run awaiting human review (AB-20): armorer's
   * `needs_approval` tool-approval flow AND durable `requestHumanInput`
   * (`ctx.waitForSignal`) waits, across all live runs. Newest requests last
   * are NOT guaranteed — order is run-registration order, not age order.
   * Excludes items already resolved via `reviews.resolve` (approved, denied, or
   * rejected), even if the underlying run has not produced further activity.
   * Also excludes any `tool-approval` review whose binding's `expiresAt` is at
   * or before the current clock time (AB-46) — a read-time filter with no
   * write; the expiry pass is the write that transitions it to `'expired'`.
   */
  list(): PendingReview[];

  /**
   * COR-1828 — the reviews a person has decided (approved, denied or rejected) and that
   * `retention.audit` has not retired, newest decision first. `resolvedAfter` keeps only those
   * decided at or after that instant (epoch milliseconds). Reads the Bureau's resolved-review
   * records, so a Bureau with no key-value store (an ephemeral one) answers empty. A review that
   * expired, was revoked or was canceled has no decision and is not listed; `get` still answers it
   * from the audit trail.
   */
  listResolved(filter?: { readonly resolvedAfter?: number }): Promise<ResolvedReview[]>;

  /**
   * Look up one review by id, live or resolved (AB-46). For a still-pending
   * id this is `reviews.list()`'s live scan. For a resolved id, this
   * reconstructs `PendingReview & { status }` from the chronologically-last
   * `review.*` audit-trail record matching `detail.review.id === id` —
   * `undefined` when no audit trail is configured (ephemeral bureau) or when
   * `id` matches nothing at all.
   */
  get(id: string): Promise<(PendingReview & ReviewResolutionFields) | undefined>;

  /**
   * The human waits a run is still parked on, read from durable state (COR-1579), so a process
   * that shares a durable store with the one holding the run can list, read and resolve its park.
   * When this process holds the run it returns the run's entries from
   * {@link BureauReviews.list}. Otherwise it derives the park as recovery does: the park,
   * its ordinal and its prompt from the run's checkpoint, still pending while the engine's
   * `waitingForSignals` names its signal. A session run's review carries the session from the
   * durable run input. Empty for a run that is not parked on
   * a human wait, or that this Bureau has no durable engine to read. Pending tool approvals are
   * not derived.
   */
  pendingOf(taskId: string): Promise<PendingHumanWaitReview[]>;

  /**
   * Approve, deny, or reject a pending review (AB-46). Approve resumes the
   * run: a `tool-approval` calls `Toolbox.resumeApproval` on the bureau's
   * toolbox and returns its `ToolExecutionResult`; a `human-wait` calls
   * `signalSession` with the parked signal name. Deny records the decision
   * without resuming anything for `tool-approval` (the binding is revoked; no
   * run to continue), and delivers `{ __abDenied: true, reason? }` on the
   * parked signal for `human-wait`, continuing that run one generation step.
   * Reject is deny plus a REQUIRED `input.reason`: `reviews.resolve` throws
   * `BureauError('reject requires a reason', 'BAD_REQUEST')` before any state
   * change when it is absent or empty. A `tool-approval` reject echoes
   * `input.reason` on `ResolveReviewResult.feedback`; a `human-wait` reject
   * delivers `{ __abRejected: true, reason: input.reason }` on the signal.
   * Every resolution is recorded in the audit trail attributed to
   * `input.principal`.
   *
   * A `tool-approval` resolution also writes its outcome into the session's
   * conversation (COR-855): the executed result on approve, an error result
   * carrying the reason on deny and reject, each replacing the pending
   * `action_required` tool-result row in place, so the next run started on the
   * session answers an up-to-date conversation. The row's metadata says who
   * decided and when, with the note and the sentence the tool asked with
   * (`approvalDecision`, COR-2016), so a page that was not there can say so. A
   * resolution the policy gates again (`superseded`) writes nothing.
   *
   * It starts no run. The chat's AG-UI resume and the `bureau.reviews.resolve`
   * operation each start the run that answers a chat's decided approvals, under
   * one command id per decided run (`http/review-continuation.ts`, COR-2016).
   *
   * Throws `BureauError('NOT_FOUND')` when `input.id` does not match a
   * currently pending review (including an already-resolved one).
   */
  resolve(input: ResolveReviewInput): Promise<ResolveReviewResult>;
}
