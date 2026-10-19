/**
 * What a schedule starts, and so which service writes it. There is one scheduler, Weft's, and it
 * lists every schedule; the Bureau owns two kinds of them and writes them itself.
 *
 * - `agent-run`: a Bureau schedule that fires the built-in `agentRun` workflow with a prompt for an
 *   agent. `bureau.schedules.*` writes it, with the revision the caller read.
 * - `workflow-file`: the schedule of an agent-authored workflow, which is the trigger in its file.
 *   `bureau.workflows.pause` and `resume` write it, with the hash of the file the caller read, and
 *   a change to anything else about it is a change to the file, so it is made in the editor.
 * - `code`: any other workflow type, which the engine writes: `weft.schedules.*`.
 * - `unknown`: the Bureau has not said yet, or could not, so nothing is written to it. A schedule
 *   is never written through the wrong service for want of knowing which owns it.
 */
import { listBureauSchedules } from './bureau-schedules.ts';
import { listWorkflowFiles, type WorkflowFileListing } from './workflow-files.ts';

/** The built-in workflow type a Bureau schedule fires. */
export const AGENT_RUN_TYPE = 'agentRun';

export type ScheduleKind =
  | {
      readonly kind: 'agent-run';
      /** The agent each fire runs, or `null` when the Bureau does not show this caller the schedule. */
      readonly agentName: string | null;
    }
  | { readonly kind: 'workflow-file'; readonly file: WorkflowFileListing }
  | { readonly kind: 'code' }
  | { readonly kind: 'unknown' };

/** What the Bureau knows about the engine's schedules. */
export type ScheduleOverlay = {
  /** The agent each Bureau schedule runs, by schedule id. */
  readonly agents: ReadonlyMap<string, string>;
  /** The workflow files, by identifier, which is the name of the type they start. */
  readonly files: ReadonlyMap<string, WorkflowFileListing>;
};

/** Reads both lists the kinds come from. A failure of either is thrown: a kind is never guessed. */
export async function loadScheduleOverlay(options?: {
  readonly signal?: AbortSignal;
}): Promise<ScheduleOverlay> {
  const [schedules, files] = await Promise.all([
    listBureauSchedules(options),
    listWorkflowFiles(options),
  ]);
  const agents = new Map<string, string>();
  for (const schedule of schedules) {
    if (schedule.agentName !== null) agents.set(schedule.id, schedule.agentName);
  }
  return { agents, files: new Map(files.map((file) => [file.id, file])) };
}

/**
 * The kind of one schedule, from its id and the type it starts. A workflow file names its type, so
 * a schedule that starts one is the file's. `agentRun` is the Bureau's. Anything else the engine
 * owns. Without the overlay the kind is `unknown`.
 */
export function kindOf(
  schedule: { readonly id: string; readonly workflowType: string },
  overlay: ScheduleOverlay | undefined,
): ScheduleKind {
  if (overlay === undefined) return { kind: 'unknown' };
  const file = overlay.files.get(schedule.workflowType);
  if (file !== undefined) return { kind: 'workflow-file', file };
  if (schedule.workflowType === AGENT_RUN_TYPE) {
    return { kind: 'agent-run', agentName: overlay.agents.get(schedule.id) ?? null };
  }
  return { kind: 'code' };
}
