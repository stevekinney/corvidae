/**
 * The words of the refusals a resume answers with as `RUN_FAILED` (`ag-ui-resume.ts`). A client
 * cannot tell the refusal of an attempt that is still going from the refusal of one that failed by
 * any field but these words, so they are named here, and the Interborough chat client's test imports
 * them: a rewording fails that test, and does not silently change what the page shows (COR-1590).
 */

/** An attempt at this very resume is still going: the request is fine, and sent again it is applied. */
export const RESUME_ATTEMPT_STILL_GOING_MESSAGES = {
  stillBeingApplied: 'An earlier attempt at this resume is still being applied; try again shortly',
  inProgress: 'Another attempt at this resume is in progress; try again',
  leaseLost: 'This resume lost its lease to another attempt before it finished; try again',
} as const;

/** An attempt failed: what it carried may be applied in part, and the person is told. */
export const RESUME_ATTEMPT_FAILED_MESSAGES = {
  answersNotApplied: 'The answers could not be applied; answer the interrupts again',
  someAnswersNotApplied: 'Some of the answers could not be applied; answer the interrupts again',
  outcomeNotWritten:
    'The approval was applied, but its outcome was not written into the conversation, so the run was not continued; send a new message to continue the thread',
  continuationNotStarted:
    'The approvals were applied, but the run that continues from them could not be started; send a new message to continue the thread',
} as const;
