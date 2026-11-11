import type { Subscription } from '@lostgradient/lifecycle';
import type {
  DurableEventEnvelope,
  DurableEventGap,
  DurableEventPage,
  EffectiveContextRecord,
  LivenessSnapshot,
  PlanReason,
  RunEvent,
  RunResult,
  SessionInputPayload,
} from '@lostgradient/operative';
import type { TaskCancelOutcome, TaskListPage, TaskListQuery, TaskView } from '../task-registry';
import type { StartTaskOrigin } from '../task-origin';
import type {
  ListFilter,
  ListOptions,
  PaginatedResult,
  WorkflowState,
  WorkflowSummary,
} from '@lostgradient/weft';
import type { ToolRequestContext } from 'armorer';
import type { ConversationHistory, Message } from 'conversationalist';
import type {
  AgentDefinitions,
  AgentHasOutput,
  AgentNames,
  AgentOutput,
  BureauAgentCatalog,
} from '../agent-catalog';
import type { AgentFileDefinitionInput } from '../agent-file';
import type { RunCreationReceipt, RunCreationReceiptLocation } from '../command-ledger';
import type {
  DurableEventHistoryPageOptions,
  DurableEventHistorySubscribeOptions,
} from '../durable-event-history';
import type {
  EventHistoryDeletedAggregateOutcome,
  EventHistoryNotFoundOutcome,
  EventHistoryUnsupportedOutcome,
} from './common';
import type { RunDetail } from './runs';

/**
 * What {@link BureauTasks.start} runs: a message for the context (a string, or an ordered list of
 * parts, as `AgentInput` takes), a conversation that seeds a new context, conversation rows to
 * append with their own ids (as an A2A continuation sends them), or `{ continue: true }` to answer
 * the context's conversation as it stands (an AG-UI resume).
 */
export type TaskInput =
  | SessionInputPayload
  | {
      /** Seeds a new context with this conversation. Naming a `contextId` too is `BAD_REQUEST`. */
      readonly conversation: ConversationHistory;
    }
  | {
      /** Rows appended to the context's conversation verbatim, ids and parts included. */
      readonly append: readonly Message[];
    }
  | {
      /** Answers the context's conversation as it stands, which must end in a user or tool row. */
      readonly continue: true;
    };
/** How {@link BureauTasks.start} starts a task. */
export interface StartTaskOptions {
  /**
   * The context to continue. Omitted, the task creates a context. A context bound to another
   * agent is `BAD_REQUEST`; another principal's reads as one that does not exist (`NOT_FOUND`).
   */
  readonly contextId?: string;
  /**
   * The owner of record of the task, and of a context it creates: the authenticated principal that
   * started it. Omitted, the task is owned by `anonymous:local`.
   */
  readonly principal?: string;
  /**
   * The caller's idempotency key for this start. A retry with the same principal, agent, and key
   * and the same `agentName`, `input`, `contextId`, and `requestContext` returns the original task;
   * the same key with any of those changed is refused with `BureauLedgerConflictError`. Needs
   * `principal` (`BAD_REQUEST` otherwise) and a durable engine (`NOT_CONFIGURED`, subject
   * `durable`). Bound to its task until {@link BureauRetentionOptions.receipts} after it settles.
   * A receipt that cannot be recorded rejects the start with `RunCreationReceiptUnrecordedError`
   * naming the task, which is aborted; a retry returns it.
   */
  readonly commandId?: string;
  /** Authenticated, request-scoped authority forwarded to Armorer tool execution. */
  readonly requestContext?: ToolRequestContext;
  /**
   * Where the task came from, recorded on its record and mirrored as the run's `origin:<kind>`
   * tag (COR-1867). Only the kind, and for a person the surface, is declared; a chat's context,
   * agent, and principal are the ones this start resolved. Omitted, the task's origin is
   * `{ kind: 'api' }`. It is not part of the command a `commandId` identifies: a retry from
   * another surface replays the original task and its origin.
   */
  readonly origin?: StartTaskOrigin;
  /** Aborts the task when it fires, from the moment the task starts executing. */
  readonly signal?: AbortSignal;
  /** The caller's trace context, the parent of the task's spans. */
  readonly traceContext?: unknown;
  /** Runs the task's work under `parent`, the caller's tracer binding. */
  readonly withTraceContext?: <T>(parent: unknown, fn: () => Promise<T>) => Promise<T>;
}
/** What `bureau.agents.try` takes besides the definition and the first input. */
export interface TryAgentOptions {
  /** The principal that owns the context: who may follow up on it and delete it. */
  readonly principal?: string;
  /** The request context of the first task, as {@link StartTaskOptions.requestContext}. */
  readonly requestContext?: ToolRequestContext;
  /** Aborts the first task when it fires. */
  readonly signal?: AbortSignal;
}
/** What `bureau.agents.try` started. */
export interface TryAgentResult {
  /**
   * The new context, whose origin is `try`. Follow-up goes to it by `tasks.start(agentName, input,
   * { contextId })`; deleting it removes the context, its tasks and the agent.
   */
  readonly contextId: string;
  /**
   * The name the tried agent runs under. It starts with `try:`, is in no catalog, and is valid
   * only for `contextId`.
   */
  readonly agentName: string;
  /** The first task, which answers the first input. */
  readonly taskId: string;
}
/**
 * The agent catalog with the one operation that reaches past it (COR-1911): `try`, which builds an
 * agent from a definition that is not saved and starts a throwaway context with it.
 */
export interface BureauAgents<D extends AgentDefinitions> extends BureauAgentCatalog<D> {
  /**
   * Builds an agent from `definition` with the schema and checks of an agent file (so a definition
   * that would not load as a file is refused with the same field-named error: `tools.1`, `model`)
   * and starts a new context with it over `input`, without writing an agent file, a snapshot, or a
   * catalog entry. The context's origin is `try`: it is left out of `contexts.list` unless that is
   * asked for, and its tasks out of `tasks.list` unless asked for by context or agent. Its runs
   * remember nothing, offer no `scheduleWakeup` or `decide`, start no child, and a definition that
   * lists a tool that writes memory, schedules, or delegates (`memory_store`, `memory_correct`, `memory_forget`,
   * `scheduleSelf`, `scheduleWakeup`, `workflows-*`, `settings-update`, `transfer_to_*`) is
   * refused. The agent lives in memory, for the context: deleting the context removes it, and a
   * restart ends it, leaving a context that can be read and deleted but not continued.
   * Rejects with an `AgentFileError` for a definition that is refused.
   */
  try(
    definition: AgentFileDefinitionInput,
    input: TaskInput,
    options?: TryAgentOptions,
  ): Promise<TryAgentResult>;
}
/**
 * A started task. It iterates the task's run events; `result()` settles with the run's result,
 * `abort()` requests cancellation (a no-op once the task has settled), and `snapshot()` reads its
 * liveness now. A handle a `commandId` retry replays for a task this process does not run settles
 * `result()` from {@link BureauTasks.wait}.
 */
export interface TaskHandle<O = unknown> extends AsyncIterable<RunEvent> {
  /** The task's id. */
  readonly id: string;
  /** The context the task runs in. */
  readonly contextId: string;
  /** The receipt of a start that named a `commandId`. */
  readonly receipt?: RunCreationReceipt;
  /** Settles with the run's result once the task has ended. */
  result(): Promise<RunResult<O>>;
  /** Requests cancellation of the task; once it has settled, does nothing. */
  abort(reason?: string): void;
  /** The task's liveness as of now. */
  snapshot(): LivenessSnapshot;
}
/** Which `commandId` {@link BureauTasks.receipt} looks up, scoped as the ledger key is. */
export interface TaskReceiptQuery {
  /** The authenticated caller that issued the start. */
  readonly commandId: string;
  readonly principal: string;
  /** The agent the task ran as. Required unless `contextId` names an existing context. */
  readonly agentName?: string | undefined;
  /** The context the start continued, whose agent the task then ran as. */
  readonly contextId?: string | undefined;
}
/**
 * One step of a task's run as its reply details show it (COR-1810): why the step's generation ran on
 * the model it did, and what that model saw. A step recorded before either was kept reads `null`.
 */
export interface TaskInspectionStep {
  /** The step's index in the run. */
  readonly step: number;
  /** The id of the assistant row the step committed, or `null` when it committed none. */
  readonly messageId: string | null;
  /** The effective-context epoch the step's generation was issued under, or `null` when the run sealed none. */
  readonly contextEpochId: string | null;
  /** Why the step ran on its model, or `null` when the run had no model plan and no steering override. */
  readonly planReason: PlanReason | null;
  /** Whether the step kept an effective context; the list form carries this in place of the record. */
  readonly hasEffectiveContext: boolean;
  /**
   * What the step's model saw, as digests and message ids capped at 256 KiB. Read only when the
   * inspection names one `step`; `null` in the list form and for a step that kept none.
   */
  readonly effectiveContext: EffectiveContextRecord | null;
}
/** What {@link BureauTasks.inspect} reads about one task. */
export interface TaskInspection {
  readonly task: TaskView;
  /** The run's liveness, or `undefined` when this process holds no live run for the task. */
  readonly liveness: LivenessSnapshot | undefined;
  /** The children the task's run owns, in the order the topology records them. */
  readonly children: readonly {
    readonly childRunId: string;
    readonly childAgentName: string;
    readonly status: string;
    readonly parentCancellation: string;
    readonly revision: number;
    /** The child's liveness, or `undefined` when this process holds no live run for it. */
    readonly liveness: LivenessSnapshot | undefined;
  }[];
  /**
   * The run's steps with their reply details, oldest first: the newest {@link INSPECTED_STEP_LIMIT}
   * steps, or just the one asked for with `options.step`. Empty for a Bureau with no durable
   * engine, whose steps are not kept.
   */
  readonly steps: readonly TaskInspectionStep[];
}
/** How many of a run's newest steps {@link TaskInspection.steps} lists when no step is asked for. */
export const INSPECTED_STEP_LIMIT = 50;
/**
 * One answer to a task's open wait, for {@link BureauTasks.respond}. Send exactly one of `answer`,
 * `data`, and `decision`.
 */
export interface TaskRespondRequest {
  /** The task whose wait is answered. */
  readonly taskId: string;
  /** The caller's idempotency key for this command, at most 200 characters. */
  readonly messageId: string;
  /** Answer text for a human-input wait; a list of parts is joined with a newline. */
  readonly answer?: string | readonly string[] | undefined;
  /** The answer of a human wait that carries an input schema, validated against it. */
  readonly data?: Readonly<Record<string, unknown>> | undefined;
  /** The decision on an approval or a human wait. */
  readonly decision?: 'approve' | 'deny' | 'reject' | undefined;
  /** Required, and non-blank, for `reject`. */
  readonly reason?: string | undefined;
  /** Addresses the human wait with this signal. */
  readonly signalName?: string | undefined;
  /** Addresses the tool approval for this call. */
  readonly callId?: string | undefined;
  /**
   * Who answers: the owner string (`api-key:<subject>` or `anonymous:local`) the answer is
   * recorded as resolved by, and the caller the receipt belongs to.
   */
  readonly principal: string;
  /**
   * Answer as an operator: another owner's human-input waits may be answered, and an approval of
   * a task `principal` does not own is answered as a missing task. Omitted, only the task's owner
   * may answer. `createBureauHandler` sets it for a caller holding `bureau.tasks:write`.
   */
  readonly operator?: boolean | undefined;
}
/** What {@link BureauTasks.respond} answered, and the receipt an exact retry returns. */
export interface TaskRespondResult {
  readonly taskId: string;
  readonly messageId: string;
  /** The review the command resolved. */
  readonly reviewId: string;
  readonly kind: 'tool-approval' | 'human-wait';
  readonly decision: 'approve' | 'deny' | 'reject';
  /** `applied`, or `superseded` when the approval was gated again and the tool did not run. */
  readonly receipt: 'applied' | 'rejected' | 'superseded';
  /** A `tool-approval` reject only: the reason, for the next run to splice in. */
  readonly feedback?: string | undefined;
}
/** The output a task of the catalog agent `TName` settles with: its schema's, else `unknown`. */
export type TaskOutputOf<
  D extends AgentDefinitions,
  TName extends keyof D & string,
> = TName extends TName
  ? AgentHasOutput<D, TName> extends true
    ? AgentOutput<D, TName>
    : unknown
  : never;
/**
 * The tasks of a Bureau: start one, and read, wait on, watch, and cancel it.
 * `bureau.tasks.*` operations served by `createBureauHandler` delegate to these members. None of
 * them authorizes the caller beyond the principal a start or a receipt names.
 */
export interface BureauTasks<D extends AgentDefinitions = AgentDefinitions> {
  /**
   * Starts a task of the catalog agent `agentName` with `input`, in the context
   * `options.contextId` names or in a new one. The task is durable when a durable engine is
   * composed and otherwise runs in memory. Refusals land before anything is persisted: an unknown
   * agent is `NOT_FOUND`, an agent with no definition resolver `UNSUPPORTED_CAPABILITY`.
   */
  start<TName extends AgentNames<D>>(
    agentName: TName,
    input: TaskInput,
    options?: StartTaskOptions,
  ): Promise<TaskHandle<TaskOutputOf<D, TName>>>;
  /** Starts a task of an agent named at run time, such as a file agent; its output is untyped. */
  start(agentName: string, input: TaskInput, options?: StartTaskOptions): Promise<TaskHandle>;
  /**
   * A task this process holds, by id, with its steps, events, transcript, and liveness. A task is
   * held after it settles until its record expires under {@link BureauRetentionOptions.tasks}.
   * `undefined` for any other id.
   */
  detail(id: string): RunDetail | undefined;
  /** The task's record, from the task registry; `undefined` for a task it does not hold. */
  get(id: string): Promise<TaskView | undefined>;
  /** A page of the task registry's tasks, as `query` filters and pages them. */
  list<T = TaskView>(query: TaskListQuery<T>): Promise<TaskListPage<T>>;
  /**
   * Cancels a task and reports where its cleanup stands, waiting up to `waitMilliseconds`
   * (default 0) for the acknowledgement: `cancel-requested`, `canceled`, `cleanup-pending`,
   * `cleaned-up`, `cleanup-failed`, `cleanup-unresolved`, `unknown-outcome`, or `rejected` (the
   * task had already finished). A task the registry does not hold is `NOT_FOUND`.
   */
  cancel(id: string, options?: { readonly waitMilliseconds?: number }): Promise<TaskCancelOutcome>;
  /**
   * Where a `commandId`'s receipt stands: `recorded`, `pending`, `expired`, or `not-found`. A
   * blank principal or command id is `BAD_REQUEST`; without a durable engine, `NOT_CONFIGURED`.
   */
  receipt(query: TaskReceiptQuery): Promise<RunCreationReceiptLocation>;
  /**
   * The durable engine's view of the task's workflow: `null` when the engine does not know it,
   * `undefined` when no durable engine is composed.
   */
  workflow(id: string): Promise<WorkflowState | null | undefined>;
  /** The durable engine's workflows, filtered; `undefined` when no durable engine is composed. */
  workflows(
    filter?: ListFilter,
    options?: ListOptions,
  ): Promise<PaginatedResult<WorkflowSummary> | undefined>;
  /**
   * Resolves with the task's workflow state once it is terminal in the durable store, `null`
   * when the engine does not know it, and `undefined` when no durable engine is composed. Under
   * `maintenance: 'manual'` a task that is not yet terminal rejects (`UNSUPPORTED_CAPABILITY`).
   */
  wait(id: string): Promise<WorkflowState | null | undefined>;
  /**
   * Delivers the task's liveness now and again on every change, until unsubscribed or `signal`
   * fires. A task this process does not hold is `NOT_FOUND`.
   */
  snapshot(
    id: string,
    observer: (snapshot: LivenessSnapshot) => void,
    options?: { signal?: AbortSignal },
  ): Subscription;
  /** A page of the task's durable event history. */
  events(
    id: string,
    options?: DurableEventHistoryPageOptions,
  ): Promise<
    | DurableEventPage
    | DurableEventGap
    | EventHistoryUnsupportedOutcome
    | EventHistoryNotFoundOutcome
    | EventHistoryDeletedAggregateOutcome
  >;
  /** Subscribes to the task's durable event history: a replay from the cursor, then the live tail. */
  subscribeEvents(
    id: string,
    listener: (event: DurableEventEnvelope) => void,
    options?: DurableEventHistorySubscribeOptions,
  ): Subscription;
  /**
   * The task's record, its run's liveness, and the children it owns, for the run inspector;
   * `undefined` for a task the registry does not hold.
   */
  inspect(
    id: string,
    options?: { readonly step?: number | undefined },
  ): Promise<TaskInspection | undefined>;
  /**
   * Answers one open wait of a task as `request.principal`: answer text or structured `data` for
   * a human-input wait, or a `decision` on an approval or a human wait. `signalName` or `callId`
   * says which wait when several are open; with neither, exactly one must be. Only the task's
   * owner may answer, unless `request.operator` is set (see {@link TaskRespondRequest.operator});
   * another owner's task, and a task the registry does not hold, are `NOT_FOUND`. An exact retry
   * of a `messageId` returns the original receipt, even after the task's record is gone; the same
   * `messageId` with another command is `CONFLICT`, as are a task with no open wait and a review
   * already resolved. A malformed request, or an answer the wait cannot take, is `BAD_REQUEST`.
   */
  respond(request: TaskRespondRequest): Promise<TaskRespondResult>;
}
