/**
 * The agent tool that reads a run's step timeline (COR-2542): `runs-timeline`, offered to an agent
 * file as `bureau:runs-timeline` and to a provider as `bureau__runs-timeline`. It serves the
 * projection `bureau.runs.timeline` serves, and the Interborough run timeline panel opens over its
 * result in Chat.
 *
 * It is a read of a run, not a workflow-management tool, so it exists on every Bureau that can
 * serve a timeline: one with agents and no workflow directory has it too. It answers only for a run
 * the calling run owns: the owner of record of the calling run, read through the shared run
 * authority and not from anything the request carried, must be the owner of the run asked about.
 * Any other run, a run that does not exist, and a call with no run behind it all answer
 * `not-found`, and the engine is not read until the caller has been let in.
 *
 * @module run-timeline-tool
 */

import { createTool, type Tool } from 'armorer';
import { z } from 'zod';

import { mayRunUseSharedConfiguration } from './run-authority.ts';
import type { ServedRunTimeline } from './run-timeline.ts';
import type { WorkspaceRuntimeAuthority } from './http/workspace-principal.ts';
import { runIdOf } from './workflow-tools';

/** The name of the tool within the `bureau` plugin. Hyphens, because provider tool-name grammars exclude dots. */
export const RUN_TIMELINE_TOOL_NAME = 'runs-timeline';

/** What the tool reads from the Bureau that owns it. */
export interface RunTimelineToolHost {
  readonly workspace?: WorkspaceRuntimeAuthority | undefined;
  /** The owner of record of a run, or `undefined` when the run is not known. */
  readonly ownerOfRun: (runId: string) => Promise<string | undefined>;
  /**
   * The step timeline of the run `runId`, an agent run's or a workflow instance's: `undefined` when
   * no such run exists, and `'unsupported'` for a Bureau with no durable engine. The tool calls it
   * only after the calling run has been let in to the run.
   */
  readonly runTimeline: (runId: string) => Promise<ServedRunTimeline | 'unsupported' | undefined>;
}

/** The `runs-timeline` tool, bound to the Bureau it reads from. */
export function createRunTimelineTool(host: RunTimelineToolHost): Tool {
  return createTool({
    name: RUN_TIMELINE_TOOL_NAME,
    version: '1.0.0',
    description:
      'Read the step timeline of one run owned by the calling run, an agent run or a workflow-file run: each step’s label, status, start, duration and tries, and where the run stands. No step’s input or output is returned.',
    input: z.object({ runId: z.string().min(1) }),
    metadata: {
      readOnly: true,
      title: 'Read run timeline',
      shortDescription: 'Read a run’s step timeline.',
    },
    execute: async (input, context) => {
      const notFound = { status: 'not-found' as const, id: input.runId };
      const callingRunId = runIdOf(context);
      if (callingRunId === undefined) return notFound;
      const owner = await host.ownerOfRun(callingRunId);
      const resourceOwner = await host.ownerOfRun(input.runId);
      if (
        owner === undefined ||
        owner !== resourceOwner ||
        !(await mayRunUseSharedConfiguration(
          host.workspace,
          owner,
          'bureau.tasks:read',
          false,
          resourceOwner,
          { allowOperatorScope: false },
        ))
      ) {
        return notFound;
      }
      const timeline = await host.runTimeline(input.runId);
      if (timeline === undefined) return notFound;
      if (timeline === 'unsupported') {
        return { status: 'unavailable' as const, reason: 'no-durable-engine' as const };
      }
      return { status: 'ok' as const, runId: input.runId, ...timeline };
    },
  });
}
