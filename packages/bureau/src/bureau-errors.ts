import { type SignedPendingToolApproval } from 'armorer';
import type { BureauToolbox } from './runtime-composition-types';
import { formatReviewAnswerIssues, type ReviewAnswerIssue } from './review-answer';
import { type TaskRespondRefusal } from './tasks/respond-to-task';

/**
 * Discriminates *why* a `BureauError` with code `NOT_CONFIGURED` was thrown.
 * `NOT_CONFIGURED` alone is not enough for a consumer to decide an HTTP status:
 * some subjects mean "this deployment does not compose that capability at all"
 * (`durable` — a 501 case), others mean "the capability exists but
 * is unconfigured, and the operator can fix it" (`generate`, `persistence`,
 * `approval` — a 503 case). Only set on `NOT_CONFIGURED` errors.
 */
export type BureauErrorNotConfiguredSubject =
  | 'generate'
  | 'durable'
  | 'persistence'
  | 'approval'
  /** COR-1920: a secret answer arrived, and the Bureau has no `answerEncryption` key or no storage for it. */
  | 'encryption';

export class BureauError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'NOT_CONFIGURED'
    | 'BAD_REQUEST'
    | 'RATE_LIMITED'
    | 'UNSUPPORTED_CAPABILITY'
    | 'STORAGE_UNAVAILABLE';
  readonly subject: BureauErrorNotConfiguredSubject | undefined;

  // `subject` is required for NOT_CONFIGURED and disallowed for every other
  // code — a compile-time guarantee that a future NOT_CONFIGURED throw site
  // cannot skip disambiguation and reintroduce the ambiguity #264 fixed.
  constructor(message: string, code: Exclude<BureauError['code'], 'NOT_CONFIGURED'>);
  constructor(message: string, code: 'NOT_CONFIGURED', subject: BureauErrorNotConfiguredSubject);
  constructor(
    message: string,
    code:
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'NOT_CONFIGURED'
      | 'BAD_REQUEST'
      | 'RATE_LIMITED'
      | 'UNSUPPORTED_CAPABILITY'
      | 'STORAGE_UNAVAILABLE',
    subject?: BureauErrorNotConfiguredSubject,
  ) {
    super(message);
    this.name = 'BureauError';
    this.code = code;
    this.subject = subject;
  }
}

/**
 * `resolveReview` resolved a tool approval, and the tool ran or was refused, but
 * the outcome could not be written into the session's conversation. The review is
 * resolved and will not be offered again; the conversation still shows it as
 * pending until a later write replaces the row.
 *
 * The decision took effect: only the write into the conversation failed. The code
 * is `CONFLICT` for lack of a better one, and a management-plane consumer must not
 * read it as another resolver having won.
 */
export const APPROVAL_OUTCOME_NOT_WRITTEN_MESSAGE =
  'The decision was recorded, but its outcome could not be written into the conversation, which still shows the approval as pending';

export class ApprovalOutcomeNotWrittenError extends BureauError {
  constructor(message: string) {
    super(message, 'CONFLICT');
    this.name = 'ApprovalOutcomeNotWrittenError';
  }
}

/**
 * A tool call waiting for approval names a tool version the toolbox no longer holds (COR-1872). A
 * durable record pins `namespace:name@version` and runs only that version: `reason` is
 * `version-mismatch` when other versions of the tool are loaded, which `candidates` lists, and
 * `missing` when none is. Recovery reports it as the cause of the review it cannot restore, and
 * `resolveReview` throws it rather than run another version; either way the tool does not run.
 */
export class PinnedToolUnavailableError extends BureauError {
  /** Why the pinned id did not resolve. */
  readonly reason: 'missing' | 'ambiguous' | 'version-mismatch';
  /** The `namespace:name@version` the run recorded. */
  readonly toolId: string;
  /** The ids of the loaded tools that came closest; empty for `missing`. */
  readonly candidates: readonly string[];
  constructor(
    toolId: string,
    reason: 'missing' | 'ambiguous' | 'version-mismatch',
    candidates: readonly string[],
  ) {
    super(
      `The run recorded tool "${toolId}", and the toolbox ${
        candidates.length === 0 ? 'holds no version of it' : `holds ${candidates.join(', ')}`
      } (${reason}).`,
      'CONFLICT',
    );
    this.name = 'PinnedToolUnavailableError';
    this.reason = reason;
    this.toolId = toolId;
    this.candidates = candidates;
  }
}

/**
 * The error for an approval whose binding pins a tool id `toolbox` no longer resolves, or
 * `undefined` when it resolves or the approval pins none.
 */
export function pinnedToolUnavailable(
  toolbox: Pick<BureauToolbox, 'resolveTool'>,
  approval: Pick<SignedPendingToolApproval, 'approvalBinding'>,
): PinnedToolUnavailableError | undefined {
  const toolId = approval.approvalBinding?.toolDefinitionRevision;
  if (typeof toolId !== 'string') return undefined;
  const resolution = toolbox.resolveTool(toolId);
  return resolution.ok
    ? undefined
    : new PinnedToolUnavailableError(toolId, resolution.reason, resolution.candidates);
}

/**
 * `resolveReview` was given the round the caller read, and the review has moved past it: another
 * resolver superseded the approval, which replaces it under the same id with the next round
 * (COR-1659). Nothing took effect, so it is a `CONFLICT` the caller answers by reading the review
 * again; it names no other resolver's decision.
 */
export class ReviewRoundChangedError extends BureauError {
  constructor(message: string) {
    super(message, 'CONFLICT');
    this.name = 'ReviewRoundChangedError';
  }
}

/**
 * `reviews.resolve` was given an answer that does not satisfy the schema of the human wait it
 * answers (COR-1804), or none where the schema needs one. Nothing was claimed, delivered or
 * audited, so the review stays pending and the caller may answer again. It is a `BAD_REQUEST`
 * `BureauError`; the catalog maps it to `InvalidParams` with the issues under `data.issues`.
 */
export class ReviewAnswerInvalidError extends BureauError {
  /** Every way the answer fails its schema; paths are relative to the answer. */
  readonly issues: readonly ReviewAnswerIssue[];

  constructor(issues: readonly ReviewAnswerIssue[]) {
    super(
      `The answer does not satisfy the question’s schema: ${formatReviewAnswerIssues(issues)}`,
      'BAD_REQUEST',
    );
    this.name = 'ReviewAnswerInvalidError';
    this.issues = issues;
  }
}

/**
 * A steering command was refused because it switches the model of an agent with `limits.cost` to
 * one the catalog has no price for (COR-1921). It is a `BAD_REQUEST` `BureauError`, so the
 * catalog's steer answers `InvalidParams` naming the `override` field and the budget; a fork
 * that carries a model across catches it, and answers the carry as rejected.
 */
export class UnpricedSwitchRefusedError extends BureauError {
  constructor(message: string) {
    super(message, 'BAD_REQUEST');
    this.name = 'UnpricedSwitchRefusedError';
  }
}

/**
 * A command was refused because Bureau had closed admission (COR-1559). It is a `CONFLICT`
 * `BureauError`, so every caller that handled the throw still does, and it carries when Bureau
 * refused it, on the Bureau's own clock, for a caller that answers with data instead of a throw.
 */
export class BureauShuttingDownError extends BureauError {
  /** When Bureau refused the command, as an ISO timestamp of its runtime clock. */
  readonly at: string;

  constructor(message: string, at: string) {
    super(message, 'CONFLICT');
    this.name = 'BureauShuttingDownError';
    this.at = at;
  }
}

/**
 * New work refused because its context is archived (COR-2285): a task started in it, input sent
 * to it, a steering command for it, a regenerated answer, or a schedule's fire into it. It is a
 * `CONFLICT` `BureauError` with the stable `reason` `context-archived`, so a caller tells it apart
 * from a missing context, which is `NOT_FOUND`. Nothing was stored. Unarchiving the context lets
 * the same request through.
 */
export class ContextArchivedError extends BureauError {
  /** The stable reason a client branches on. */
  readonly reason = 'context-archived' as const;
  /** The archived context. */
  readonly contextId: string;

  constructor(contextId: string) {
    super(`Context "${contextId}" is archived: unarchive it to continue.`, 'CONFLICT');
    this.name = 'ContextArchivedError';
    this.contextId = contextId;
  }
}

/**
 * An archive refused because the context has a live task (COR-2285): one running, or one waiting
 * on an approval or an answer. It is a `CONFLICT` `BureauError` with the stable `reason`
 * `context-busy`; nothing was stored. Stopping the task, or answering it, lets the archive through.
 */
export class ContextBusyError extends BureauError {
  /** The stable reason a client branches on. */
  readonly reason = 'context-busy' as const;
  /** The context that has a live task. */
  readonly contextId: string;

  constructor(contextId: string) {
    super(
      `Context "${contextId}" has a task running or waiting on an answer: stop or answer it before archiving.`,
      'CONFLICT',
    );
    this.name = 'ContextBusyError';
    this.contextId = contextId;
  }
}

/**
 * A refusal of {@link BureauTasks.respond}, made before anything took effect. It is a
 * `BureauError` (`NOT_FOUND`, `CONFLICT`, or `BAD_REQUEST`) that also says which request `field`
 * a `BAD_REQUEST` is about, or the short `reason` an addressed wait cannot take the answer, so the
 * management plane answers it as `InvalidParams` or `Unprocessable` without reading the message.
 */
export class TaskRespondError extends BureauError {
  readonly field: string | undefined;
  readonly reason: string | undefined;
  /** Every field of the answer that failed the wait's schema, when that is what was refused (COR-1804). */
  readonly issues: TaskRespondRefusal['issues'];

  constructor(refusal: TaskRespondRefusal) {
    super(refusal.message, refusal.code);
    this.name = 'TaskRespondError';
    this.field = refusal.field;
    this.reason = refusal.reason;
    this.issues = refusal.issues;
  }
}

/**
 * What `Bureau.whenRunRecorded` rejects with when the run ended without this process saving its
 * end in the session, so no record of it is coming from here.
 */
export class TerminalSessionRecordAbandonedError extends Error {
  constructor(runId: string) {
    super(`Run "${runId}" ended without its end being recorded in its session by this process.`);
    this.name = 'TerminalSessionRecordAbandonedError';
  }
}

/**
 * Thrown by `schedules.create` when a schedule registers successfully against
 * the engine but its {@link import('@lostgradient/weft').ScheduleSummary}
 * cannot be retrieved immediately afterward (`AgentScheduleHandle.describe()`
 * rejects). Mirrors `DurableCapabilityUnavailableError`'s shape discipline
 * (AB-41/AB-43) — `.code`, `.category`, `.retryable` — so the same
 * `isToolError`-style consumer contract can discriminate it without a bare,
 * untyped `Error` leaking through. The schedule itself IS registered; only
 * its locator (the summary) is unavailable.
 */
export class ScheduleLocatorUnavailableError extends Error {
  readonly code = 'ScheduleLocatorUnavailableError';
  readonly category = 'unavailable' as const;
  readonly retryable = false as const;
  /** The already-registered schedule whose locator could not be read. */
  readonly scheduleId: string;

  constructor(scheduleId: string, options?: { cause?: unknown }) {
    super(
      `Schedule ${scheduleId} was registered, but its summary could not be retrieved. ` +
        `The schedule is registered; retry describing it (e.g. bureau.schedules.get('${scheduleId}')) later.`,
      options,
    );
    this.name = 'ScheduleLocatorUnavailableError';
    this.scheduleId = scheduleId;
  }
}

/**
 * Thrown by `schedules.create` (COR-1667) when `agentName` is not in the agent catalog, instead of
 * registering a schedule whose every fire would be refused with `missing-agent`. A `NOT_FOUND`
 * {@link BureauError}, so the management plane answers it as a client error; the name is on
 * `agentName`.
 */
export class UnknownScheduleAgentError extends BureauError {
  /** The catalog name no agent resolves. */
  readonly agentName: string;

  constructor(agentName: string) {
    super(
      `Unknown agent "${agentName}": a schedule can only run an agent in the catalog`,
      'NOT_FOUND',
    );
    this.name = 'UnknownScheduleAgentError';
    this.agentName = agentName;
  }
}

export function toBadRequest(message: string): never {
  throw new BureauError(message, 'BAD_REQUEST');
}
