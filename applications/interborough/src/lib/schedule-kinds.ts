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
import { RUN_ENGINE_WORKFLOW_TYPE } from '@lostgradient/operative/run-engine-workflow-types';

import type { HttpClient } from '@lostgradient/weft';

import { listBureauSchedules } from './bureau-schedules.ts';
import { listDefinitions } from './workflow-catalog.ts';
import { listWorkflowFiles, type WorkflowFileListing } from './workflow-files.ts';

/** The built-in workflow type a Bureau schedule fires. */
export const AGENT_RUN_TYPE = RUN_ENGINE_WORKFLOW_TYPE.agentRun;

/**
 * What a schedule starts each time it fires: an agent run, a workflow file, code registered in the
 * host, or something the dashboard cannot name.
 */
export type ScheduleKind =
  | {
      readonly kind: 'agent-run';
      /** The agent each fire runs, or `null` when the Bureau does not show this caller the schedule. */
      readonly agentName: string | null;
    }
  | { readonly kind: 'workflow-file'; readonly file: WorkflowFileListing }
  | { readonly kind: 'code' }
  | { readonly kind: 'unknown' };

/**
 * What the Bureau and the engine say of the schedules, each source as far as it answered. A source
 * that did not answer is `undefined`, and `failed` says the Bureau's did not, so the page can say so.
 */
export type ScheduleOverlay = {
  /** The agent each Bureau schedule runs, by schedule id. */
  readonly agents: ReadonlyMap<string, string> | undefined;
  /** The start of the text each Bureau schedule sends its agent, by schedule id. */
  readonly inputs: ReadonlyMap<string, string> | undefined;
  /**
   * The schedules the Bureau listed that run no agent, which are the triggers of workflow files,
   * by schedule id, each with the type it starts. Only the Bureau says a schedule is a file's, and it
   * says so by the schedule's id: a schedule the engine made for a file's type is the engine's.
   */
  readonly fileSchedules: ReadonlyMap<string, string> | undefined;
  /** The workflow files, by identifier, which is the name of the type they start. */
  readonly files: ReadonlyMap<string, WorkflowFileListing> | undefined;
  /**
   * How the engine holds each workflow type: as code, or as a source it loaded, which is how a
   * workflow file is held. Read only when the Bureau's files did not answer, to say whether a type
   * is a file's.
   */
  readonly origins: ReadonlyMap<string, 'code' | 'source'> | undefined;
  /** Whether the Bureau failed to answer one of its two lists. */
  readonly failed: boolean;
};

/**
 * Reads the Bureau's schedules and workflow files, each on its own, so a list that fails leaves the
 * other to be used. When the Bureau's files did not answer, it also reads how the engine holds each
 * type, which says a type the engine holds as code is not a file's: a schedule the engine owns is
 * never held up because the Bureau did not answer. Otherwise the engine is not asked.
 */
export async function loadScheduleOverlay(
  client: HttpClient,
  options?: { readonly signal?: AbortSignal },
): Promise<ScheduleOverlay> {
  const [schedules, files] = await Promise.allSettled([
    listBureauSchedules(options),
    listWorkflowFiles(options),
  ]);
  const engine =
    files.status === 'rejected' ? await Promise.allSettled([listDefinitions(client)]) : undefined;
  const definitions = engine?.[0];
  const agents = new Map<string, string>();
  const inputs = new Map<string, string>();
  const fileSchedules = new Map<string, string>();
  if (schedules.status === 'fulfilled') {
    for (const schedule of schedules.value) {
      if (schedule.agentName === null) fileSchedules.set(schedule.id, schedule.workflowType);
      else {
        agents.set(schedule.id, schedule.agentName);
        if (schedule.inputPreview !== null) inputs.set(schedule.id, schedule.inputPreview);
      }
    }
  }
  return {
    agents: schedules.status === 'fulfilled' ? agents : undefined,
    inputs: schedules.status === 'fulfilled' ? inputs : undefined,
    fileSchedules: schedules.status === 'fulfilled' ? fileSchedules : undefined,
    files:
      files.status === 'fulfilled'
        ? new Map(files.value.map((file) => [file.id, file]))
        : undefined,
    origins:
      definitions?.status === 'fulfilled'
        ? new Map(definitions.value.map((definition) => [definition.name, definition.origin]))
        : undefined,
    failed: schedules.status === 'rejected' || files.status === 'rejected',
  };
}

/**
 * Whether a type is a workflow file's: the Bureau's list of files says so when it answered, and
 * otherwise a type the engine holds as code is not, and one it holds as a source may be, so it is
 * not told.
 */
function isFileType(type: string, overlay: ScheduleOverlay): boolean | undefined {
  if (overlay.files !== undefined) return overlay.files.has(type);
  return overlay.origins?.get(type) === 'code' ? false : undefined;
}

/**
 * The kind of one schedule, from its id and the type it starts. `agentRun` is the Bureau's, named
 * when the Bureau names its agent. A type that is not a workflow file's is the engine's, whether
 * or not the Bureau answered. A schedule of a file's type is the file's only when the Bureau listed
 * its id as one that runs no agent; it is the engine's when the Bureau did list the file's own
 * schedule; and when whose it is cannot be told, it is of no known kind and nothing is written to
 * it. Before anything has answered the kind is `unknown`.
 */
export function kindOf(
  schedule: { readonly id: string; readonly workflowType: string },
  overlay: ScheduleOverlay | undefined,
): ScheduleKind {
  if (overlay === undefined) return { kind: 'unknown' };
  if (schedule.workflowType === AGENT_RUN_TYPE) {
    return { kind: 'agent-run', agentName: overlay.agents?.get(schedule.id) ?? null };
  }
  const fileType = isFileType(schedule.workflowType, overlay);
  if (fileType === false) return { kind: 'code' };
  const file = overlay.files?.get(schedule.workflowType);
  if (fileType === undefined || file === undefined || overlay.fileSchedules === undefined) {
    return { kind: 'unknown' };
  }
  if (overlay.fileSchedules.get(schedule.id) === schedule.workflowType) {
    return { kind: 'workflow-file', file };
  }
  const bureauListedTheFilesOwn = [...overlay.fileSchedules.values()].includes(
    schedule.workflowType,
  );
  return bureauListedTheFilesOwn ? { kind: 'code' } : { kind: 'unknown' };
}
