import type { LivenessSnapshot, TokenUsage } from '@lostgradient/operative';
import type { ToolRequestContext } from 'armorer';
import type { ConversationHistory, Message, MultiModalContent } from 'conversationalist';

export interface RunSummary {
  id: string;
  sessionId: string;
  status: string;
  steps: number;
  /**
   * Token usage, including AB-92's `cacheCreationTokens`/`cacheReadTokens`
   * when the provider reported them (absent, never fabricated as `0`, when
   * it did not — see {@link TokenUsage}).
   */
  usage: TokenUsage;
  finishReason: string | undefined;
  error: string | undefined;
  actionCount: number;
  /**
   * The agent that ran this run (AB-54 usage analytics grouping). Resolved
   * deterministically from `CreateRunRequest.agentName` (falling back to the
   * house default) at run-creation time. A run reattached after durable
   * recovery — whose process restarted, losing the in-memory resolution —
   * falls back to the tool-bubble-event heuristic and may be `undefined` for
   * a recovered run with no tool activity yet.
   */
  agentName: string | undefined;
  /**
   * The owner of record of the run: the principal it was created with
   * (e.g. `api-key:<id>`), from the run's attribution, or the owner its
   * liveness snapshot reports when no attribution was recorded (one
   * reader, shared with {@link Bureau.ownerOf}). A run reattached after
   * durable recovery keeps it: it is rehydrated from the owning session's
   * `lastRunOwningPrincipals` (AB-359). A run created with no principal reads
   * `undefined` on the direct branch and `anonymous:local` on the durable one;
   * {@link Bureau.ownerOf} and the AG-UI mount read both as `anonymous:local`
   * through the same default.
   */
  principal: string | undefined;
  /**
   * Epoch-ms timestamp of the run's first recorded action (`run.started`).
   * `undefined` only in the vanishingly brief window between `store.register`
   * and the first action being appended.
   */
  startedAt: number | undefined;
}
/**
 * Resolution of Bureau's durable cancel of a task no process-local run holds, which
 * {@link BureauTasks.cancel} takes for such a task (AB-37, AB-205).
 * Never a rejection — every failure mode, including one raised by the engine
 * itself, is represented as a variant here instead.
 */
export type CancelDurableRunOutcome =
  | { readonly status: 'requested' }
  | { readonly status: 'already-terminal' }
  | { readonly status: 'not-found' }
  | { readonly status: 'unsupported-capability' }
  | { readonly status: 'failed'; readonly error: unknown };
export interface RunStepDetail {
  step: number;
  content: string;
  /** The step's settled output parts; generated media is a managed-asset reference (COR-713). */
  parts: readonly MultiModalContent[];
  /** The id of the assistant row the step committed; absent when it committed none. */
  messageId?: string | undefined;
  final: boolean;
  usage?: TokenUsage | undefined;
  toolCalls: readonly {
    id?: string;
    name: string;
    arguments?: unknown;
  }[];
  results: readonly {
    toolName: string;
    result: unknown;
    error?: string | undefined;
  }[];
}
export interface RunEventRecord {
  sequence: number;
  runId: string;
  event: string;
  detail: unknown;
  timestamp: number;
}
export interface RunDetail extends RunSummary {
  events: RunEventRecord[];
  stepDetails: RunStepDetail[];
  /**
   * The current branch's conversation as of the last completed step or run
   * completion, or `undefined` before any step completes. This is the
   * transcript only: the full undo/branch history stays in the operative
   * store's `RunState.snapshots`.
   */
  transcript: ConversationHistory | undefined;
  /**
   * The run's current liveness snapshot (AB-88/AB-214), plain-data and
   * JSON-safe. `getRun(id)` carries the value observed at call time; a
   * caller wanting live updates calls `bureau.subscribeRunSnapshot(id, ...)`
   * instead of polling `getRun`.
   */
  liveness: LivenessSnapshot;
}
export interface CreateRunRequest {
  /**
   * A user message to append to the session's conversation. Optional when
   * {@link CreateRunRequest.appendMessages} supplies the rows, or when the
   * conversation already ends in a user or tool-result row (the run answers
   * it). The conversation the run starts from must end in such a row; else
   * `BAD_REQUEST`.
   */
  message?: string | undefined;
  /**
   * Rows to append to the session's conversation, after the conversation and
   * the system prompt and after `message` when both are given. They are
   * appended verbatim, with their ids and content parts; an id the session
   * already holds is `BAD_REQUEST`. The request digest covers them (by
   * everything but the `createdAt` and `position` the append re-stamps), so an
   * exact retry digests the same.
   */
  appendMessages?: ReadonlyArray<Message> | undefined;
  sessionId?: string;
  /**
   * COR-1577 — the catalog agent to run. The run executes that agent's own `generate`, tools,
   * system prompt and stop conditions, as `tasks.start(name, …)` does, with this Bureau's opt-in
   * tools (`requestHumanInput`, `scheduleWakeup`) and memory around them.
   *
   * A session is bound to the agent of the run that created it. A later run names that same agent;
   * a request that leaves the field out at runtime (the type no longer allows it) still inherits
   * the session's agent. Naming another is refused with `BAD_REQUEST`. A name that is not in the
   * catalog, `bureau` (the implicit agent that no longer exists) included, is refused with
   * `NOT_FOUND`; both land before anything is persisted.
   *
   * The system prompt, `maximumSteps`, `maximumTokens`, and stop conditions are the agent's (COR-1707:
   * a run carries none of its own). The session's request context governs tool approvals, never the
   * agent's `executeOptions.requestContext`.
   *
   * The run uses that agent's own `generate`, tools, and stop condition. A durable run
   * recovers as its agent: one whose agent has left the catalog fails, and one whose
   * definition revision changed logs a warning and resumes with the current definition.
   *
   * Required: callers name the agent explicitly.
   */
  agentName: string;
  /**
   * The owner of record of this run (COR-718), and of the session it creates:
   * the authenticated principal that started it (e.g. `api-key:<id>`). It is
   * stored once, when the run is created, and decides who may later read the run,
   * its session, and its reviews. Omitted, the run is owned by `anonymous:local`.
   * A host serving outside callers supplies it from the caller's credential,
   * never from a request payload: `createBureauHandler` does so itself.
   *
   * A different principal starting a run on an existing session is refused as a
   * session that does not exist (`BureauError` `NOT_FOUND`).
   */
  principal?: string;
  /** Authenticated, request-scoped authority forwarded to Armorer tool execution. */
  requestContext?: ToolRequestContext | undefined;
  /**
   * COR-424 — the caller's idempotency key for this run-creation command.
   * When present, the start records the command in a durable ledger keyed
   * by `(principal, agentName, runCreationRequestId, operation version)`,
   * with surrounding whitespace trimmed from the request id (the principal is
   * keyed exactly as the run records its owner), and a digest of the payload
   * (`agentName`, the task input, `contextId`, and the request context's `authority`, `audience`,
   * and `locale`), and
   * resolves with a receipt. Requires `principal`, since an idempotency key
   * needs an authenticated caller to belong to, and a bureau with a durable
   * engine (`NOT_CONFIGURED` otherwise), since a receipt promises a retry
   * after a restart finds the original run. The request id stays bound to its
   * run until {@link BureauRetentionOptions.receipts} after the
   * run settles; after that it creates a new run.
   */
  runCreationRequestId?: string | undefined;
}
/** COR-424 — which run-creation request {@link BureauTasks.receipt} looks up. */
export interface LocateRunCreationReceiptRequest {
  /** The authenticated caller that issued the request. */
  principal: string;
  /**
   * The agent the request ran as. Required unless `sessionId` names an existing session, whose
   * agent it then is.
   */
  agentName?: string | undefined;
  /**
   * The session the request continued. A request that omitted `agentName` on an existing
   * session ran as the session's agent and was keyed under it, so name the session to find it
   * without knowing the agent. A session that does not exist, or that another principal owns,
   * binds nothing; one bound to an agent other than `agentName` is refused with `BAD_REQUEST`.
   */
  sessionId?: string | undefined;
  runCreationRequestId: string;
}
