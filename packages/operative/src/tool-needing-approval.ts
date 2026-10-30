/**
 * Which tool call of a run needed a person's approval that the run could not get (COR-1913).
 *
 * A call can end `action_required`, which parks an attended run on the approval. In a run nobody
 * started, such as a workflow's `agent` step, there is no requester to bind an approval to, and
 * Armorer fails the call instead: the model is told the call did not run and goes on, so the run
 * finishes without the change it was started for. A host that must not take that for success asks
 * this about the run's tool results.
 *
 * @module tool-needing-approval
 */

/** The part of a tool result {@link toolNeedingApproval} reads. */
export interface ApprovalCheckedResult {
  /** How the call ended: `action_required` for a call held for approval, `error` for a failure. */
  readonly outcome: string;
  /** The tool the call was for. */
  readonly toolName?: string | undefined;
  /** The structured error of a failed call, whose message is read. */
  readonly error?: { readonly message?: string | undefined } | undefined;
  /** The error message of a failed call that carries it as plain text. */
  readonly errorMessage?: string | undefined;
}

/**
 * Where Armorer's message begins when it could not issue an approval because the run had no
 * request context to bind it to. A test that runs a real unattended step fails if the text moves.
 */
const APPROVAL_UNAVAILABLE_MESSAGE_START = 'Approval authorization requires';

/**
 * The name of the tool of the first result that ended `action_required`, or that Armorer failed
 * because it could not issue an approval for it; `undefined` when no result did. A result with no
 * tool name answers an empty string.
 */
export function toolNeedingApproval(
  results: ReadonlyArray<ApprovalCheckedResult>,
): string | undefined {
  for (const result of results) {
    if (result.outcome === 'action_required') return result.toolName ?? '';
    if (
      result.outcome === 'error' &&
      (result.error?.message ?? result.errorMessage)?.startsWith(APPROVAL_UNAVAILABLE_MESSAGE_START)
    ) {
      return result.toolName ?? '';
    }
  }
  return undefined;
}
