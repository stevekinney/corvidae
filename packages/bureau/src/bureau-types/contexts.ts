import type { Subscription } from '@lostgradient/lifecycle';
import type {
  AgentSession,
  CleanupAcknowledgement as RunCleanupAcknowledgement,
  DurableEventEnvelope,
  DurableEventGap,
  DurableEventPage,
  SessionInputAdmissionOutcome,
  SessionInputAdmissionRequest,
  SessionInputRetractionOutcome,
  SessionInputRetractionRequest,
  SessionListOptions,
  SessionSummary,
} from '@lostgradient/operative';
import type {
  DurableEventHistoryPageOptions,
  DurableEventHistorySubscribeOptions,
} from '../durable-event-history';
import type { ForkSessionRequest, ForkSessionResult } from '../session-fork';
import type { RegenerateSessionRequest, RegenerateSessionResult } from '../session-regenerate';
import type {
  SessionSteeringState,
  SteeringCommandAdmissionOutcome,
  SteeringCommandRequest,
} from '../steering';
import type {
  ContextArchivedError,
  ContextBusyError,
  ContextNotArchivableError,
} from '../bureau-errors';
import type {
  EventHistoryDeletedAggregateOutcome,
  EventHistoryNotFoundOutcome,
  EventHistoryUnsupportedOutcome,
} from './common';

/** What fills a context's window: one of the five categories {@link ContextWindowReport} splits it into. */
export type ContextWindowCategoryName = 'system' | 'tools' | 'messages' | 'memory' | 'attachments';
/** One category of a {@link ContextWindowReport} and the tokens it holds. */
export interface ContextWindowCategory {
  /** What the tokens are: the `system` instructions, the `tools` offered, the conversation's `messages`, recalled `memory`, or media `attachments`. */
  readonly name: ContextWindowCategoryName;
  /** The estimated tokens (four characters to a token; an attachment by its byte size and kind). */
  readonly tokens: number;
}
/**
 * How full a context's window is (COR-1937, {@link BureauContexts.window}).
 *
 * `usedEstimated` is Bureau's own size estimate of the prompt the context's next step would send,
 * and always equals the sum of `categories`, which lists all five categories once, in the order
 * `system`, `tools`, `messages`, `memory`, `attachments`. `usedReported` is the provider's own
 * count, never an estimate: the input tokens (fresh, cache-read and cache-written) of the context's
 * latest step, `null` when there is none or the provider reported none. The latest step is looked
 * for among the context's 50 newest tasks, so a context whose 50 newest tasks all ended before a
 * step reads `null`. It describes the request that step sent, so once the run has ended it lags
 * `usedEstimated` by that step's reply and tool results; mid-run, a chat that saves its rows only
 * when its run ends (a scheduled fire saves after every step) can have the reverse, an estimate
 * behind the steps already sent. `maxTokens` is
 * the context window of the model that would answer, from the model catalog: the context's steered
 * model, else its agent's default, and `null` when neither names a catalog row.
 */
export interface ContextWindowReport {
  /** The model's context window in tokens, or `null` when the model is not known. */
  readonly maxTokens: number | null;
  /** The estimated tokens of the next prompt: the sum of `categories`. */
  readonly usedEstimated: number;
  /** The input tokens the provider reported for the latest step, or `null`. */
  readonly usedReported: number | null;
  /** The estimate split by what fills the window. */
  readonly categories: readonly ContextWindowCategory[];
}
/**
 * The contexts (sessions) of a Bureau: reading and deleting them, signalling a parked run, admitting
 * input and steering, branching, and the history of their events. A context is the durable
 * conversation a task runs in; `bureau.contexts.*` operations served by `createBureauHandler`
 * delegate to these members. None of them authorizes the caller: that is the caller's to do, as for
 * {@link BureauContexts.get}.
 */
export interface BureauContexts {
  /** The summaries of the contexts this Bureau holds, as `options` filters, sorts, and pages them. */
  list(options?: SessionListOptions): Promise<SessionSummary[]>;

  /** One context by id, or `undefined` when this Bureau does not hold it. */
  get(id: string): Promise<AgentSession | undefined>;

  /**
   * Deletes a session (a context), and resolves a {@link ContextDeletionReport} of
   * what the deletion did to the tasks that were live in it (COR-1481). A caller
   * that ignores the report is unaffected.
   *
   * The deletion fences the session first: while it is in flight, a new run on the
   * id, session input to it, and a signal to it read as a session that does not
   * exist. It cancels every live run in the session, not only the latest, then
   * deletes the session, and empties the originating message history of each of
   * its tasks. With `options.incarnation` it deletes only that incarnation of the
   * session: an id reused since the caller read the session is left untouched and the
   * report says nothing was deleted. It resolves when every run it cancelled has ended; each task's
   * `closed` acknowledgement may settle later.
   */
  delete(
    id: string,
    options?: {
      readonly incarnation?: string | undefined;
      /**
       * Who asked for the deletion (COR-2018): an owner identifier, which the deletion's audit entry
       * carries as its `principal`, so the log can say who deleted the chat. Left out, the entry
       * names no actor, as one for a chat the store expired does not.
       */
      readonly actor?: string | undefined;
    },
  ): Promise<ContextDeletionReport>;

  /**
   * Gives a session (a context) a title, or removes the one it was given (COR-1909). `title` is
   * stored in the session's metadata and wins over the title derived from the first user message in
   * every summary until it is removed: `null` removes it, and the derived title returns. Text is
   * trimmed, and must be non-empty and at most `SESSION_TITLE_OVERRIDE_LIMIT` characters, or the
   * call throws a `BureauError` `BAD_REQUEST`. Renaming does not count as activity: the session's
   * `updatedAt`, and so its place in a listing, does not move. Setting the title it already has is
   * not an error. With `options.incarnation` it renames only that incarnation: an id reused since
   * the caller read the session is left untouched.
   *
   * Resolves the renamed session, or `undefined` when this Bureau holds no such session (or none of
   * that incarnation). It does not authorize the caller: that is the caller's to do, as for
   * {@link BureauContexts.get}. Throws a `BureauError` `CONFLICT` when Bureau is shutting down.
   */
  rename(
    contextId: string,
    title: string | null,
    options?: { readonly incarnation?: string | undefined },
  ): Promise<AgentSession | undefined>;

  /**
   * Archives a context (COR-2285): records when, on the runtime clock, in its metadata
   * (`SESSION_ARCHIVED_AT_METADATA_KEY`). An archived context accepts no new work: a task started
   * in it, input, a steering command, a regenerated answer and a schedule's fire into it are
   * refused with a {@link ContextArchivedError}. Reading, renaming, deleting, forking, forgetting
   * grants and the window keep working. Archiving does not count as activity: `updatedAt`, and so
   * the context's place in a listing, does not move.
   *
   * A context with a live task (running, or waiting on an approval or an answer) is refused with a
   * {@link ContextBusyError}, and nothing is stored. A goal's session is refused with a
   * {@link ContextNotArchivableError}: its goal writes to it through its own path. The decision is
   * fenced on the session revision it was made from. A task start saves the session in the write
   * that starts its run, and a schedule's fire saves it after each step; each of those writes
   * refuses a context archived meanwhile (a fire that has already written once goes on, since the
   * archive found it live). So an archive and a start, or a fire, racing on one context never both
   * commit. Input and steering are refused on a read made before they are admitted, which an archive
   * can follow: input admitted that way finds no run to take it and is cancelled, but a steering
   * command can be logged.
   * Archiving an archived context is not an error: it answers `changed: false` and the time it was
   * first archived. With `options.incarnation` it archives only that incarnation.
   *
   * Resolves `undefined` when this Bureau holds no such context (or none of that incarnation). It
   * does not authorize the caller, and throws a `BureauShuttingDownError` when Bureau is shutting
   * down.
   */
  archive(
    contextId: string,
    options?: { readonly incarnation?: string | undefined },
  ): Promise<ContextArchiveOutcome | undefined>;

  /**
   * Unarchives a context (COR-2285): removes the archive record, so it accepts work again.
   * Unarchiving a context that is not archived is not an error: it answers `changed: false`. It
   * does not count as activity. With `options.incarnation` it unarchives only that incarnation.
   * Resolves `undefined` when this Bureau holds no such context (or none of that incarnation). It
   * does not authorize the caller, and throws a `BureauShuttingDownError` when Bureau is shutting
   * down.
   */
  unarchive(
    contextId: string,
    options?: { readonly incarnation?: string | undefined },
  ): Promise<ContextArchiveOutcome | undefined>;

  /**
   * Deliver a fire-and-forget signal to a session's current in-flight durable run.
   * Maps to `engine.signal(runId, name, payload)`. Requires a durable engine and a
   * session store. Throws `BureauError('NOT_CONFIGURED', subject: 'durable')` when no durable
   * engine is composed; throws `BureauError('NOT_FOUND')` when the session has no current run.
   */
  signal(contextId: string, name: string, payload?: unknown): Promise<void>;

  /**
   * AB-42/AB-194 — admit a caller's session input as a fifth session verb.
   * Pre-admission checks run in AB-42's fixed order: authorization, then
   * session lifecycle, then capability/capacity. An unauthorized caller or an
   * unknown `sessionId` returns `{ outcome: 'not-found' }` (indistinguishable
   * by design — the document's authorization-denial rule). An authorized
   * caller naming a session already in a terminal state returns
   * `{ outcome: 'session-terminal', sessionId }`. Both checks consult this
   * process's live runs (COR-301, `resolveSessionPreAdmission`): a session
   * with any live run is not terminal, whichever run last wrote
   * `lastRunStatus`, and authorization targets the session's sole live run,
   * falling back to `lastRunId` only when several runs are live.
   *
   * On a durably-configured Bureau every other authorized, non-terminal
   * request is admitted to the session's durable mailbox (`admitted`,
   * `replayed`, `conflict`, or `backlog-exhausted`). Each admitted input ends
   * with exactly one terminal receipt. It reads `promoted` once a live run's
   * step boundary appends its user turn to the conversation: before the run's
   * next step generates, or once more after its last step generated while the
   * run has a step left. The turn is appended at most once, in admission order
   * within a run, keyed by the mailbox command so a reused `id` is a new input
   * (an `id` must therefore be unique for the life of the session: the turn
   * carries it as its message id, and a second turn under the same `id` takes
   * a fresh message id instead),
   * under the input's own `id` as its message id, and the promotion commits in
   * the write that saves the turn, whatever that step's outcome. It reads
   * `canceled` when the input was not appended before its run ended, however
   * it ended (completed, failed, cancelled through `tasks.cancel`, or promoted
   * but never started), so the client resends it; Bureau never starts a run to
   * answer input, and the ending run cancels what it never delivered unless
   * another run of the session is live, whose end does the cancelling. With no
   * run live or starting when the admission commits, this call cancels the
   * input itself and returns the re-read receipt. Shutdown releases open input
   * instead, for the next boot's recovered run to deliver or its sweep to
   * cancel. An input still undelivered after seven days reads `expired`, one
   * whose session is deleted reads `canceled`, and one that cannot be decoded
   * reads `failed`. `steer` and `queue` share that one FIFO path; `expiresAt`
   * and `supersedes` are stored but not yet honored. A Bureau with no session
   * mailbox, durable storage, or key-value store, or a session id too long to
   * address a mailbox, returns `{ outcome: 'unsupported-capability', reason:
   * 'durable-mailbox-unavailable' }`.
   */
  input(
    contextId: string,
    request: SessionInputAdmissionRequest,
  ): Promise<SessionInputAdmissionOutcome>;

  /**
   * B06 — take back one input `request.principal` admitted to the context, before any run takes
   * it: a follow-up the person removes while it is still queued. The input's mailbox command is
   * cancelled, so it is never delivered, and the outcome is `retracted` with its `canceled`
   * receipt (or the receipt of an input that had already ended undelivered). An input a run
   * already took into the conversation, or holds at the step boundary that is appending it, is
   * `delivered`: the turn stands. An unknown context or incarnation, an unknown id, and another
   * principal's input are `not-found`, and a Bureau with no session mailbox is
   * `unsupported-capability`. Throws a `BureauError` `CONFLICT` when Bureau is shutting down.
   */
  retract(
    contextId: string,
    request: SessionInputRetractionRequest,
  ): Promise<SessionInputRetractionOutcome>;

  /**
   * B06 (row 20c) — forget the chat's "Allow for the rest of this chat" grant of each tool in
   * `tools`, by the name a tool call carries. A grant is stored under `namespace:name@version` and a
   * stored call names a namespaced tool as the provider does (`namespace__name`), so both are read
   * as that provider name: a name matches every version of its tool, and no other namespace's tool
   * of the same name. Retry on a reply that failed sends a new turn over a
   * thread that still holds the failed attempt, and this puts the interrupted tool back behind its
   * approval. Nothing else of the context changes, no row of its conversation is removed, and
   * `updatedAt` does not move. Resolves the grants forgotten, as they were stored (empty when none
   * matched), or `undefined` for a context this Bureau does not hold (or none of
   * `options.incarnation`). It does not authorize the caller, and throws a
   * `BureauShuttingDownError` once the Bureau is shutting down.
   */
  forgetGrants(
    contextId: string,
    tools: readonly string[],
    options?: { readonly incarnation?: string | undefined },
  ): Promise<readonly string[] | undefined>;

  /**
   * COR-1490 — the identifiers of the conversation rows `runId` itself took session input into,
   * in delivery order, from the durable delivery record (which commits with the transcript the
   * run saved). Empty for a run that delivered none, and for a Bureau with no session mailbox.
   */
  inputsDeliveredBy(taskId: string, contextId: string): Promise<readonly string[]>;

  /**
   * AB-67/AB-199/AB-200 — admit a steering command as a sixth session verb,
   * for in-memory and durable sessions alike. Reads
   * authority and terminal status through the same pre-admission decision
   * `contexts.input` uses (`resolveSessionPreAdmission`, COR-301), over
   * the session's live runs: authorization targets the request's `runId`,
   * else the session's sole live run, else `lastRunId`; and a session with
   * any live run is not terminal. An unauthorized caller or unknown
   * `sessionId` returns `{ outcome: 'not-found' }`; an authorized caller
   * naming an already-terminal session returns `{ outcome: 'session-terminal',
   * sessionId }`.
   *
   * All seven targets are admitted (AB-199/AB-200/AB-68, COR-1227):
   * `pause`/`resume` bind to one run; `agent-identity` is deferred to the
   * session's next run, and its `override` must name a key of this
   * Bureau's `agents` map (otherwise `rejected` with `policy-denied`);
   * `route`, `model`, `provider`, and `effort` apply at the next step
   * boundary. A configuration `override` is checked against the live model
   * catalog (`route` is not catalog-validated), and a configuration
   * `policyRef` resolves through `modelPolicy.users` — an unknown profile,
   * a profile that omits the coordinate, or an uncatalogued coordinate is
   * `rejected` with `policy-denied`. Only an `agent-identity` `policyRef`
   * returns `{ outcome: 'unsupported-capability', reason:
   * 'selector-unavailable' }`.
   *
   * Durable sessions are admitted too, through the session's durable
   * steering log (`steering-log.ts`): an append-only log of every
   * admission and run-boundary transition, with the inputs each was decided
   * from, committed atomically and never consumed. The session's gate is a
   * fold of it, so desired configuration, agent identity, pause state,
   * command states, and `configVersion` survive any number of restarts, and
   * every Bureau process sharing the backend folds the same history before
   * it decides. An exact `(principal, id)` retry replays and a mismatched
   * one conflicts after any restart and across sessions and processes; a
   * refused command's id stays decided too, answering an exact retry with
   * the original refusal. `pause`/`resume` bind against the session's live
   * runs in every process sharing the backend. A run reads its own process's gate: steering
   * admitted by another process reaches it when this process next folds
   * the log (before its next admission or run). `{ outcome:
   * 'unsupported-capability', reason: 'durable-steering-unavailable' }` is
   * returned only by the guard for a durably-configured Bureau with no
   * resolved storage backend, which normal composition does not produce.
   *
   * A `pause` against an authorized, non-terminal session is
   * accepted, increments the session's `configVersion` by exactly one, and
   * is idempotent against a second `pause` while the first is still
   * `accepted`/`applied` (no second increment). A `resume` against a session
   * that is not currently paused is accepted as a no-op, matching the
   * idempotent-abort precedent at
   * `documentation/operative-type-safe-api.md#required-capabilities`. An `accepted`
   * pause/resume transitions to `failed` with `SteeringCommandFailure.reason
   * = 'run-terminal'` if the targeted run aborts or completes before its
   * `runStep` boundary is reached. An exact retry of the same
   * `(principal, id)` with an identical `requestedValue` replays the
   * original command's current state; a same-`id`, different-`requestedValue`
   * reuse returns a typed conflict.
   */
  steer(
    contextId: string,
    request: SteeringCommandRequest,
  ): Promise<SteeringCommandAdmissionOutcome>;

  /**
   * What the session's steering has settled on (COR-1559): its latest admitted `model` override
   * and its `configVersion`. On a durable Bureau the session's log is folded first, so the answer
   * includes commands another process admitted. `undefined` for a session this Bureau does not
   * hold. It does not authorize the caller: that is the caller's to do, as for `contexts.get`.
   */
  steering(contextId: string): Promise<SessionSteeringState | undefined>;

  /**
   * How full the context's window is (COR-1937): the size of the prompt its next step would send,
   * split by what fills it, against the window of the model that would answer. Read-only: it calls
   * no model and writes no state, so it answers for an idle context, for a context with no run, and
   * for a running one without waiting on the run (it reads the last committed history: a chat saves
   * its rows when its run ends, a scheduled fire after every step, so a chat mid-run can show fewer
   * rows than the steps it has already sent). `undefined` for a context this Bureau does not hold, or, with
   * `options.incarnation`, one whose id now names another incarnation. It does not authorize the
   * caller: that is the caller's to do, as for `contexts.get`. See {@link ContextWindowReport}.
   */
  window(
    contextId: string,
    options?: { readonly incarnation?: string | undefined },
  ): Promise<ContextWindowReport | undefined>;

  /**
   * Branches a session at the end of a turn (COR-1560, COR-1910): a new session, owned by
   * `request.owner`, whose history is the parent's through `throughMessageId`, which must be the
   * last assistant reply of a run that has ended in this session (completed, errored or aborted),
   * with no tool approval pending and no tool call left without a result. `throughMessageId: null`
   * branches before the first message: the new session starts empty. Editing a sent message is a
   * fork at the reply before it followed by a new run of the edited text on the fork. The parent is unchanged. The new session
   * records where it came from (`SessionSummary.parentContextId`, `forkedFromMessageId`) and keeps
   * the parent's model choice: its latest `model` override is admitted on the fork as
   * `<commandId>:model`, and that outcome is returned beside the new `contextId`; a refusal of it
   * leaves the fork in place, on the agent's default.
   *
   * `commandId` is recorded in the durable command ledger (COR-424): an exact retry, even after a
   * restart, returns the original result and creates nothing more, and a crash between the steps
   * never forks twice. The same `commandId` with another `throughMessageId` throws a
   * {@link SessionForkRefusedError} with reason `command-conflict`; a message that is not a branch
   * point throws one naming why, and nothing is created. It does not authorize the caller: that is
   * the caller's to do, as for `contexts.get`. Throws a `BureauError` `CONFLICT` when Bureau is
   * shutting down.
   */
  fork(contextId: string, request: ForkSessionRequest): Promise<ForkSessionResult>;

  /**
   * Regenerates a context's latest answer without running a tool (COR-2296): the model is asked
   * once, over the history before `request.messageId`, with a toolbox that holds no tool, and its
   * answer replaces that row under the same id. Every other row (the user's message, earlier
   * replies, tool calls, tool results, approvals) is kept as it was. `messageId` must be the last
   * row of the context and the last assistant reply of its newest run, which has ended, with no
   * tool approval pending and no tool call left without a result; anything else throws a
   * {@link SessionRegenerateRefusedError} naming why before the model is asked. The model is the
   * one the context's steering names now (or the agent's default), judged by the policy as it is
   * now, never the one the old answer recorded. The call is made under the hooks a run's step is:
   * Bureau's identity prompt and guardrails, the plugin tier and the agent's own `prepareStep` and
   * `validateResponse` hooks, so a redaction is what is stored. An answer that asks for a tool, a
   * model that fails or that the policy forbids, a guardrail that halts the answer, a `prepareStep`
   * hook that answers in the model's place, an abort through `request.signal`, and a context that
   * changed after it was read (a new turn, a steering change, a deletion, a deletion and a new
   * context under the id) each throw a refusal and leave the history as it was: the replacement
   * is one compare-and-swap fenced on the incarnation and revision the attempt read, and it
   * commits the regeneration's receipt to the session outbox beside the new answer.
   *
   * `commandId` is recorded in the durable command ledger: only the attempt that claims it asks
   * the model. An exact retry, even after a restart, returns the original result; a duplicate
   * whose first attempt is still pending is answered from that attempt's committed receipt, or
   * refused `command-in-doubt` when there is none; the same `commandId` with another `messageId`
   * is refused `command-conflict`. A refusal before the commit releases the command, so an exact
   * retry tries again. It does not authorize the caller: that is the caller's to do, as for
   * `contexts.get`. Throws a `BureauError` `NOT_FOUND` for a context this Bureau does not hold,
   * and a `BureauShuttingDownError` when Bureau is shutting down.
   */
  regenerate(
    contextId: string,
    request: RegenerateSessionRequest,
  ): Promise<RegenerateSessionResult>;

  /**
   * One page of the context's durable event history, from the exclusive `options.since` cursor. It
   * is {@link BureauTasks.events} for the `session` owner: the outcomes, `options.principal`
   * authorization, and paging are that method's, so see it for the full contract.
   */
  events(
    contextId: string,
    options?: DurableEventHistoryPageOptions,
  ): Promise<
    | DurableEventPage
    | DurableEventGap
    | EventHistoryUnsupportedOutcome
    | EventHistoryNotFoundOutcome
    | EventHistoryDeletedAggregateOutcome
  >;

  /**
   * Replays the context's durable event history from the exclusive `options.since` cursor, then
   * delivers live events with no gap and no duplicate at the handoff. It is
   * {@link BureauTasks.subscribeEvents} for the `session` owner, so an ephemeral bureau returns an
   * already-closed subscription and `options.principal` applies as it does there.
   */
  subscribeEvents(
    contextId: string,
    listener: (event: DurableEventEnvelope) => void,
    options?: DurableEventHistorySubscribeOptions,
  ): Subscription;
}
/** What {@link BureauContexts.archive} and {@link BureauContexts.unarchive} did (COR-2285). */
export interface ContextArchiveOutcome {
  /** The context. */
  readonly contextId: string;
  /** Whether this call changed it: `false` for one that was already as asked. */
  readonly changed: boolean;
  /** When the context was archived, as an ISO 8601 timestamp, or `null` when it is not archived. */
  readonly archivedAt: string | null;
}

/** What {@link BureauContexts.delete} did (COR-1481). */
export interface ContextDeletionReport {
  /** Whether a session existed and was deleted. */
  readonly deleted: boolean;
  /**
   * The tasks that were live when the deletion began, each with the cleanup
   * acknowledgement of its run, which settles when the run's cleanup does.
   */
  readonly tasks: readonly {
    readonly taskId: string;
    readonly closed: Promise<RunCleanupAcknowledgement>;
  }[];
}
