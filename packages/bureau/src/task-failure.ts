/**
 * Why a task's run failed, and what step of it is on a second or later try (COR-2531): the shapes a
 * task record stores, the view shows and `bureau.tasks.list` filters by, and the checks that read
 * them back from storage.
 *
 * A failure is named by its step, its error's code and kind, and the tool call that failed, by the
 * tool's name and the call's identifier. It never holds a tool's arguments, which may hold secrets,
 * or any error text: that is read through the task's `statusMessage`.
 *
 * @module task-failure
 */

/** The longest step label, tool name or call identifier a {@link TaskFailure} keeps, in characters. */
const TASK_FAILURE_TEXT_LIMIT = 200;

/**
 * Why a run failed: which step, the error's code and kind, and the tool call that failed when one
 * did. Every field is optional because a live failure event may not have named it: a step the run
 * reconstructed after a crash is a guess, so it is left out, and a failure that no step or call
 * caused names none.
 */
export interface TaskFailure {
  /**
   * The failing step: its index in the run and its label, which for an agent run is the failing
   * tool's name, or `model` for a model step, and for a workflow run is the engine's
   * `failedStep.label`.
   */
  readonly step?: TaskFailureStep | undefined;
  /** `AgentRunError.code`, an identifier. */
  readonly errorCode?: string | undefined;
  /** `AgentRunError.kind`, a member of the closed kind list. */
  readonly errorKind?: string | undefined;
  /** The tool call that failed: the tool's name and the call's identifier, never its arguments. */
  readonly toolCall?: TaskFailureToolCall | undefined;
}

/** The failing step of a {@link TaskFailure}. */
interface TaskFailureStep {
  /** The step's index in the run, from zero. */
  readonly index: number;
  /** The step's label, at most {@link TASK_FAILURE_TEXT_LIMIT} characters. */
  readonly label: string;
}

/** The tool call a {@link TaskFailure} names. */
export interface TaskFailureToolCall {
  /** The tool's name. */
  readonly name: string;
  /** The call's identifier. */
  readonly callId: string;
}

/** {@link TaskFailure} as a view shows it: every field present, `null` when not known. */
export interface TaskFailureView {
  readonly step: TaskFailureStep | null;
  readonly errorCode: string | null;
  readonly errorKind: string | null;
  readonly toolCall: TaskFailureToolCall | null;
}

/**
 * What a run is retrying: the label of the step (`model` for a model step; for a workflow run the
 * engine's retrying activity) and the attempt it is on, which is 2 or later, as the engine's
 * `WorkflowRetrying.attempt` is.
 */
export interface TaskRetrying {
  readonly label: string;
  readonly attempt: number;
}

/**
 * Text cut to {@link TASK_FAILURE_TEXT_LIMIT} characters, never on half of a surrogate pair: the way
 * the engine cuts the `failedStep.label` it stores, so a label compares equal on both sides.
 */
export function truncateFailureText(text: string): string {
  if (text.length <= TASK_FAILURE_TEXT_LIMIT) return text;
  const cut = text.slice(0, TASK_FAILURE_TEXT_LIMIT);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * A stored {@link TaskFailure} as a view shows it, or `null` for a failure nothing described. Every
 * field a reader depends on is `null` rather than absent when it is not known.
 */
export function failureViewOf(failure: TaskFailure | undefined): TaskFailureView | null {
  if (failure === undefined) return null;
  return {
    step:
      failure.step === undefined ? null : { index: failure.step.index, label: failure.step.label },
    errorCode: failure.errorCode ?? null,
    errorKind: failure.errorKind ?? null,
    toolCall:
      failure.toolCall === undefined
        ? null
        : { name: failure.toolCall.name, callId: failure.toolCall.callId },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a stored value is a {@link TaskFailure}: a record whose present fields are well formed. */
export function isTaskFailure(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const step = value['step'];
  const toolCall = value['toolCall'];
  return (
    (step === undefined ||
      (isRecord(step) &&
        typeof step['index'] === 'number' &&
        Number.isSafeInteger(step['index']) &&
        step['index'] >= 0 &&
        typeof step['label'] === 'string')) &&
    (value['errorCode'] === undefined || typeof value['errorCode'] === 'string') &&
    (value['errorKind'] === undefined || typeof value['errorKind'] === 'string') &&
    (toolCall === undefined ||
      (isRecord(toolCall) &&
        typeof toolCall['name'] === 'string' &&
        typeof toolCall['callId'] === 'string'))
  );
}

/** Whether a stored value is a {@link TaskRetrying}: a label and an attempt of 2 or later. */
export function isTaskRetrying(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['label'] === 'string' &&
    typeof value['attempt'] === 'number' &&
    Number.isSafeInteger(value['attempt']) &&
    value['attempt'] >= 2
  );
}
