/**
 * Resuming a context's last stopped turn (COR-2437): which turn could be resumed, and why each is
 * refused today.
 *
 * Resuming means the run itself goes on from where it stopped, its reply so far kept, with no new
 * message from the person. What a stopped chat run leaves decides whether that is possible:
 *
 * - A run the person stopped, or one that failed, ends its durable workflow as `cancelled` or
 *   `failed`. The engine resumes only a workflow that is `running` or `suspended`
 *   (`WorkflowNotResumableError`), so the same run cannot go on. Going on would take a new run
 *   with no message of the person's to start it, which a session run cannot be (it always appends
 *   its input), and a new run under a new id would write the rows of the old one's steps again.
 *   Both are engine changes this operation does not make: it refuses `run-not-resumable`.
 * - A run whose process stopped (`owner-lost`) is still `running` in the engine, and the Bureau
 *   that next boots over the store recovers it itself, from its checkpoint: `turn-recovering`.
 * - A reply the model cut at its token limit ends the run normally, as any finished turn:
 *   `turn-finished`.
 * - A run still going is `turn-running`, and one waiting on an approval or a question is
 *   `turn-awaiting-person`: it goes on once the person answers.
 *
 * No path starts or changes anything, so two resumes, or a resume racing a new message, can never
 * make two live runs, and a retry under the same `commandId` is answered the same.
 *
 * @module session-resume
 */

/** Why a resume was refused. Each is stable: the management plane carries it as `data.reason`. */
export type SessionResumeRefusalReason =
  /** The run is not one of this context's runs. */
  | 'run-not-found'
  /** A later run of the context exists: only the last turn could go on. */
  | 'not-latest-turn'
  /** The run is still going. */
  | 'turn-running'
  /** The run waits on an approval or a question, and goes on once the person answers it. */
  | 'turn-awaiting-person'
  /** The run's process stopped before it recorded its end, and the Bureau recovers it itself. */
  | 'turn-recovering'
  /** The run finished normally, including a reply the model cut at its token limit. */
  | 'turn-finished'
  /**
   * The person stopped the run, or it failed: its workflow has ended, and the engine cannot go on
   * with the same run.
   */
  | 'run-not-resumable';

/** A resume that was refused. Nothing was started or changed. */
export class SessionResumeRefusedError extends Error {
  /** Why the resume was refused. */
  readonly reason: SessionResumeRefusalReason;

  constructor(reason: SessionResumeRefusalReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionResumeRefusedError';
    this.reason = reason;
  }
}

/** What {@link BureauContexts.resumeTurn} takes. */
export interface ResumeTurnRequest {
  /** The caller's owner of record. Authorization is the caller's. */
  readonly owner: string;
  /** The caller's own identifier for the command; a retry of it is answered the same. */
  readonly commandId: string;
  /** The context's last run, whose turn would go on. */
  readonly runId: string;
}

/** What {@link BureauContexts.resumeTurn} would answer once a stopped turn can go on. */
export type ResumeTurnResult = {
  /** The context whose turn went on. */
  readonly contextId: string;
  /** The run that went on. */
  readonly runId: string;
};
