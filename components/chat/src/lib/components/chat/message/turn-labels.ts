import { formatCountdown } from '../../../utilities/format-countdown.ts';
import type { ToolCallRowStatus } from './tool-call-summary.ts';

/**
 * The words of a turn's outcome and of the steps under it (COR-2283), kept apart from the
 * components so `ChatProps` can name the type without importing a Svelte file.
 */

/**
 * The words Chat draws on a turn that has not simply finished, and on the steps of its run. Each
 * is a plain string or a function of the numbers it reports, so a host can say it its own way or
 * in its own language.
 */
export type ChatTurnLabels = {
  /** Heading for a group of approvals waiting on the reader. */
  approvalWaiting: (count: number) => string;
  /**
   * The warning on a turn whose stream dropped. Default
   * `Connection lost. Reconnecting, attempt 2 of 5. Next try in 8 s.`
   */
  reconnecting: (attempt: number, attempts: number, nextTryIn: number) => string;
  /** The button that tries the connection again at once. Default `Retry`. */
  retryNow: string;
  /** The accessible name of the bar that drains until the next try. Default `Time until the next try`. */
  nextTry: string;
  /** The one neutral card on a turn the person stopped. Default `Stopped. The answer above is partial.`. */
  stopped: string;
  /** What Continue does, as its accessible description. Default `Pick the answer up again where it stopped.`. */
  continueDescription: string;
  /** What Discard does, as its accessible description. Default `Throw the partial answer away.`. */
  discardDescription: string;
  /** The primary button that picks a stopped turn up again. Default `Continue`. */
  continue: string;
  /** The secondary button that throws a stopped turn's partial answer away. Default `Discard`. */
  discard: string;
  /** The heading of the alert on a turn that failed partway. Default `This answer is incomplete.`. */
  incomplete: string;
  /** What Retry keeps, when the failed state names nothing itself. Default `Retry keeps what was written so far.`. */
  retryKeeps: string;
  /** The button that runs a failed turn again. Default `Retry`. */
  retry: string;
  /** The row on a turn that finished without an answer. Default `The agent finished without writing an answer.`. */
  empty: string;
  /** The button on that row that asks again. Default `Retry`. */
  tryAgain: string;
  /** Where the step under way falls among the steps so far. Default `Step 2 of 3`. */
  stepPosition: (position: number, total: number) => string;
  /**
   * The count in a step group's header once a step failed: the steps that worked out of all of
   * them. Default `2 of 3 steps`; a host that knows what the steps were can say `Checked 2 of 3 sources`.
   */
  stepsDone: (done: number, total: number) => string;
  /** The count in a step group's header while all steps are still successful. */
  steps: (count: number) => string;
  /** What a failed step says when its result says nothing at all. Default `This step failed.`. */
  stepFailed: string;
  /** The button on a failed step that runs it again. Default `Retry`. */
  retryStep: string;
  /** The button on a failed step that copies its error. Default `Copy error`. */
  copyError: string;
  /** What Copy error says once it has copied. Default `Copied`. */
  errorCopied: string;
  calls: (count: number) => string;
  input: string;
  output: string;
  error: string;
  yes: string;
  no: string;
  /** The visible status of one tool step. */
  toolStatus: (status: ToolCallRowStatus) => string;
  /** A problem count in a tool summary. */
  toolProblem: (count: number, status: ToolCallRowStatus) => string;
  /** The live announcement for one tool step's status. */
  toolAnnouncement: (name: string, status: ToolCallRowStatus) => string;
};

/** The words a turn uses when the host sets none. */
export const DEFAULT_TURN_LABELS: ChatTurnLabels = {
  approvalWaiting: (count) => `${count} approvals waiting`,
  reconnecting: (attempt, attempts, nextTryIn) =>
    `Connection lost. Reconnecting, attempt ${attempt} of ${attempts}. Next try in ${formatCountdown(nextTryIn)}.`,
  retryNow: 'Retry',
  nextTry: 'Time until the next try',
  stopped: 'Stopped. The answer above is partial.',
  continueDescription: 'Pick the answer up again where it stopped.',
  discardDescription: 'Throw the partial answer away.',
  continue: 'Continue',
  discard: 'Discard',
  incomplete: 'This answer is incomplete.',
  retryKeeps: 'Retry keeps what was written so far.',
  retry: 'Retry',
  empty: 'The agent finished without writing an answer.',
  tryAgain: 'Retry',
  stepPosition: (position, total) => `Step ${position} of ${total}`,
  stepsDone: (done, total) => `${done} of ${total} ${total === 1 ? 'step' : 'steps'}`,
  steps: (count) => `${count} ${count === 1 ? 'step' : 'steps'}`,
  stepFailed: 'This step failed.',
  retryStep: 'Retry',
  copyError: 'Copy error',
  errorCopied: 'Copied',
  calls: (count) => `${count} consecutive tool ${count === 1 ? 'call' : 'calls'}`,
  input: 'Input',
  output: 'Output',
  error: 'Error',
  yes: 'Yes',
  no: 'No',
  toolStatus: (status) => {
    const labels: Record<ToolCallRowStatus, string> = {
      pending: 'Pending',
      succeeded: 'Complete',
      failed: 'Failed',
      denied: 'Denied',
      expired: 'Expired',
      waiting: 'Waiting for approval',
      'waiting-input': 'Waiting for input',
      approved: 'Approved, resuming',
      answered: 'Answered',
    };
    return labels[status];
  },
  toolProblem: (count, status) => {
    const labels: Record<ToolCallRowStatus, string> = {
      pending: 'pending',
      succeeded: 'complete',
      failed: 'failed',
      denied: 'denied',
      expired: 'expired',
      waiting: 'waiting for approval',
      'waiting-input': 'waiting for input',
      approved: 'approved, resuming',
      answered: 'answered',
    };
    return `${count} ${labels[status]}`;
  },
  toolAnnouncement: (name, status) => `${name}: ${DEFAULT_TURN_LABELS.toolStatus(status)}`,
};

/** The host's words over the defaults, one label at a time. */
export function resolveTurnLabels(labels: Partial<ChatTurnLabels> | undefined): ChatTurnLabels {
  return labels === undefined ? DEFAULT_TURN_LABELS : { ...DEFAULT_TURN_LABELS, ...labels };
}
