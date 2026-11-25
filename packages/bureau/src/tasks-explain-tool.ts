/**
 * The agent tool that explains why a run failed (COR-2543): `tasks-explain`, offered to an agent
 * file as `bureau:tasks-explain` and to a provider as `bureau__tasks-explain`. It serves the answer
 * `bureau.tasks.explain` serves, from what Bureau stored about the run and nothing else, and the
 * Interborough failure explanation panel opens over its result in Chat.
 *
 * It is a read of a run, not workflow management, so it exists on every Bureau, with or without a
 * workflow directory. It answers only for a run the calling run owns: the owner of record of the
 * calling run, read through the shared run authority and not from anything the request carried,
 * must be the owner of the run asked about, and in a workspace that owner must be a current member
 * who is not a service. Any other run, a run that does not exist, and a call with no run behind it
 * all answer `not-found`, and the engine is not read until the caller has been let in.
 *
 * @module tasks-explain-tool
 */

import { createTool, type Tool } from 'armorer';
import { z } from 'zod';

import { mayRunUseSharedConfiguration } from './run-authority.ts';
import { readRunFailure, type RunFailureReads } from './run-failure-read.ts';
import type { TaskView } from './task-registry.ts';
import type { WorkspaceRuntimeAuthority } from './http/workspace-principal.ts';
import { runIdOf } from './workflow-tools';

/** The name of the tool within the `bureau` plugin. Hyphens, because provider tool-name grammars exclude dots. */
export const TASKS_EXPLAIN_TOOL_NAME = 'tasks-explain';

/** What the tool reads from the Bureau that owns it. */
export interface TasksExplainToolHost extends RunFailureReads {
  readonly workspace?: WorkspaceRuntimeAuthority | undefined;
  /** The owner of record of a run, or `undefined` when the run is not known. */
  readonly ownerOfRun: (runId: string) => Promise<string | undefined>;
  /** The task of an agent run, or `undefined` for an id the registry does not hold. */
  readonly task: (runId: string) => Promise<TaskView | undefined>;
  /** Whether `runId` is an instance of a workflow file. */
  readonly workflowInstance: (runId: string) => Promise<boolean>;
}

/** The `tasks-explain` tool, bound to the Bureau it reads from. */
export function createTasksExplainTool(host: TasksExplainToolHost): Tool {
  return createTool({
    name: TASKS_EXPLAIN_TOOL_NAME,
    version: '1.0.0',
    description:
      'Explain why one failed run owned by the calling run failed, an agent run or a workflow-file run: one sentence, the cause, the step it failed at, how often that step was tried, the guardrails that fired and what to do next, from what Bureau stored about the run. No error message, stack or tool argument is returned. A run that did not fail has nothing to explain.',
    input: z.object({ runId: z.string().min(1) }),
    metadata: {
      readOnly: true,
      title: 'Explain a failed run',
      shortDescription: 'Say why a run failed.',
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
      const task = await host.task(input.runId);
      if (task === undefined && !(await host.workflowInstance(input.runId))) return notFound;
      const read = await readRunFailure(
        host,
        task === undefined ? { kind: 'workflow' } : { kind: 'agent', task },
        input.runId,
        // A tool changes nothing, so it offers no command that does.
        async () => false,
      );
      if (read.outcome === 'unsupported') {
        return { status: 'unavailable' as const, reason: 'no-durable-engine' as const };
      }
      if (read.outcome === 'not-failed') {
        return { status: 'not-failed' as const, runId: input.runId, runStatus: read.status };
      }
      return { status: 'ok' as const, ...read.explanation };
    },
  });
}
