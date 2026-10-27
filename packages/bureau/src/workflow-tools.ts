/**
 * The tools an agent manages its workflows with (COR-1529): `workflows-create`, `workflows-update`,
 * `workflows-pause`, `workflows-resume`, and `workflows-list`. Bureau adds them to the deployment's
 * tool catalog itself when `workflowSource` is set, so an agent file receives them only when it
 * lists them in `tools`. They write through `Bureau.workflows`, the same operations HTTP callers
 * use, never to the filesystem directly.
 *
 * Every workflow belongs to the deployment's owner of record. A tool acts only when the owner of
 * record of the run that called it, read through `ownerOf` and not from anything the request
 * carried, is that owner; for any other run `workflows-list` is empty and every write answers
 * `not-found`, as if no workflow existed. The `agent` field of a file a tool writes is the calling
 * run's own agent identifier.
 *
 * Every outcome is an ordinary tool result, never a thrown error, so a conflict or a document that
 * would not load reaches the model as something it can read and correct.
 *
 * @module workflow-tools
 */

import { createTool, type Tool, type ToolContext } from 'armorer';
import { z } from 'zod';

import { AGENT_IDENTIFIER_PATTERN } from './agent-file';
import {
  checkWorkflowIdentifier,
  type WorkflowFileDefinition,
  WorkflowFileConflictError,
  WorkflowFileError,
} from './workflow-file';
import { type BureauWorkflows, WorkflowApplyError } from './workflow-runtime';

/** The names of the five tools. Hyphens, because provider tool-name grammars exclude dots. */
export const WORKFLOW_TOOL_NAMES = [
  'workflows-create',
  'workflows-update',
  'workflows-pause',
  'workflows-resume',
  'workflows-list',
] as const;

/** The name of a tool in the agent source's `tools` that one of the five would collide with, if there is one. */
export function collidingWorkflowToolName(
  tools: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  return WORKFLOW_TOOL_NAMES.find((name) => tools !== undefined && Object.hasOwn(tools, name));
}

/** What the tools read from the Bureau that owns them. */
export interface WorkflowToolHost {
  /** The workflow files. Read on every call, because the tools exist before the runtime does. */
  readonly workflows: () => BureauWorkflows | undefined;
  /** The agent identifier of a run and its owner of record, for the run that made a tool call. */
  readonly runIdentity: (
    runId: string,
  ) => Promise<{ readonly agent: string | undefined; readonly owner: string | undefined }>;
}

/** One failure in a document, located by a path such as `steps[0].handler`. */
export interface WorkflowToolIssue {
  readonly path: string;
  readonly message: string;
}

/** What every tool answers. */
export type WorkflowToolResult =
  | { readonly status: 'ok'; readonly id: string; readonly hash: string }
  | {
      readonly status: 'conflict';
      readonly id: string;
      readonly reason: 'workflow-file-exists' | 'workflow-file-changed';
      readonly currentHash?: string;
    }
  | {
      readonly status: 'invalid';
      readonly code: string;
      readonly issues: readonly WorkflowToolIssue[];
    }
  | { readonly status: 'not-found'; readonly id: string }
  | { readonly status: 'unavailable'; readonly reason: 'workflow-apply-failed' };

/** One workflow as `workflows-list` shows it. */
export interface WorkflowToolListing {
  readonly id: string;
  /** The hash `expectedHash` is set to by the tools that change the file; `null` when unreadable. */
  readonly hash: string | null;
  readonly state: 'ready' | 'invalid';
  readonly paused: boolean;
  /** The trigger's `kind`, or `null` for an `invalid` file. */
  readonly triggerKind: string | null;
  /**
   * What the workflow is for, or `null` when it has none. `workflows-update` replaces the whole
   * definition, so an agent that updates a workflow passes this back to keep it.
   */
  readonly description: string | null;
  /** Why an `invalid` file cannot run, so its author can fix it; `null` for a ready one. */
  readonly problem: string | null;
}

/** What `workflows-list` answers: the same `status` as every tool, and the workflows. */
export interface WorkflowToolListResult {
  readonly status: 'ok';
  readonly workflows: readonly WorkflowToolListing[];
}

/**
 * The identifier a workflow's name becomes: lowercase, every run of characters outside `[a-z0-9]`
 * one `-`, `-` trimmed from both ends. It must then start with a letter and be at most 64
 * characters. Returns the problem when it cannot; there is no automatic suffix.
 */
export function deriveWorkflowIdentifier(
  name: string,
): { readonly id: string } | { readonly message: string } {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (id === '') {
    return { message: `The name "${name}" has no letters or digits to make an identifier from.` };
  }
  const problem = checkWorkflowIdentifier(id);
  if (problem !== undefined) {
    return {
      message: `The name "${name}" becomes "${id}", which is not a valid identifier: ${problem.message}`,
    };
  }
  return { id };
}

const triggerSchema = z
  .record(z.string(), z.unknown())
  .describe(
    'When the workflow starts: { "kind": "schedule", "spec": "0 6 * * *" } for a cron expression or a duration such as "1h", or { "kind": "signal", "name": "..." } to start when that signal is sent.',
  );

const stepsSchema = z
  .array(z.record(z.string(), z.unknown()))
  .describe(
    'The steps, run in order: { "kind": "activity", "handler": "agent", "input": { "agent": "...", "message": "..." } }, { "kind": "sleep", "duration": "5m" }, or { "kind": "await-signal", "signal": "..." }.',
  );

const descriptionSchema = z
  .string()
  .optional()
  .describe(
    'One sentence on what the workflow is for, shown beside its name in the workflow list. Leave it out for none.',
  );

const pausedSchema = z
  .boolean()
  .optional()
  .describe('Whether the workflow starts nothing new. Leave it out to leave the workflow running.');

const expectedHashSchema = z
  .string()
  .min(1)
  .describe(
    'The `hash` workflows-list returned for this workflow; a file that changed since is a conflict.',
  );

const guardedInput = z.object({
  id: z.string().min(1).describe('The workflow identifier.'),
  expectedHash: expectedHashSchema,
});

function issuesOf(error: WorkflowFileError): readonly WorkflowToolIssue[] {
  const issues = error.problem?.issues;
  return issues === undefined || issues.length === 0
    ? [{ path: '', message: error.message }]
    : issues.map((issue) => ({ path: issue.path, message: issue.message }));
}

/** The result a failed write is reported as, or rethrows an error that is not one of the five. */
function resultOfFailure(error: unknown, id: string): WorkflowToolResult {
  if (error instanceof WorkflowFileConflictError) {
    return {
      status: 'conflict',
      id,
      reason:
        error.code === 'workflow-file-exists' ? 'workflow-file-exists' : 'workflow-file-changed',
      ...(error.currentHash === undefined ? {} : { currentHash: error.currentHash }),
    };
  }
  if (error instanceof WorkflowApplyError) {
    return { status: 'unavailable', reason: 'workflow-apply-failed' };
  }
  if (error instanceof WorkflowFileError) {
    if (error.code === 'workflow-file-not-found') return { status: 'not-found', id };
    return { status: 'invalid', code: error.code, issues: issuesOf(error) };
  }
  throw error;
}

/** The identifier of the run that made `context`'s call, when it carries one. */
function runIdOf(context: ToolContext | undefined): string | undefined {
  const fromExecution = context?.executionContext?.['parentRunId'];
  if (typeof fromExecution === 'string' && fromExecution !== '') return fromExecution;
  return typeof context?.runId === 'string' && context.runId !== '' ? context.runId : undefined;
}

/** The tools, bound to the Bureau they read from. */
export function createWorkflowTools(host: WorkflowToolHost): Record<string, Tool> {
  /** The calling run, or the result that answers a call that may not act. */
  async function caller(
    context: ToolContext | undefined,
    id: string,
  ): Promise<
    | {
        readonly workflows: BureauWorkflows;
        readonly agent: string;
        readonly actor: string;
      }
    | { readonly refusal: WorkflowToolResult }
  > {
    const workflows = host.workflows();
    const runId = runIdOf(context);
    const identity = runId === undefined ? undefined : await host.runIdentity(runId);
    if (workflows === undefined || runId === undefined || identity?.owner !== workflows.owner) {
      return { refusal: { status: 'not-found', id } };
    }
    const agent = identity.agent;
    if (agent === undefined || !AGENT_IDENTIFIER_PATTERN.test(agent)) {
      return {
        refusal: {
          status: 'invalid',
          code: 'invalid-agent',
          issues: [
            {
              path: 'agent',
              message: `The calling agent's identifier ${agent === undefined ? 'is unknown' : `"${agent}" is not a valid agent identifier`}, so it cannot own a workflow file.`,
            },
          ],
        },
      };
    }
    return { workflows, agent, actor: `agent-run:${runId}` };
  }

  const definition = (
    agent: string,
    input: {
      trigger: Record<string, unknown>;
      steps: Record<string, unknown>[];
      description?: string | undefined;
      paused?: boolean | undefined;
    },
  ): WorkflowFileDefinition => ({
    ...(input.description === undefined ? {} : { description: input.description }),
    agent,
    ...(input.paused === undefined ? {} : { paused: input.paused }),
    trigger: input.trigger as WorkflowFileDefinition['trigger'],
    steps: input.steps,
  });

  const createInput = z.object({
    name: z.string().min(1).describe('What the workflow is called.'),
    id: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The identifier, lowercase letters, digits, and hyphens, starting with a letter and at most 64 characters. Derived from `name` when you leave it out.',
      ),
    description: descriptionSchema,
    trigger: triggerSchema,
    steps: stepsSchema,
    paused: pausedSchema,
  });
  const updateInput = guardedInput.extend({
    description: descriptionSchema,
    trigger: triggerSchema,
    steps: stepsSchema,
    paused: pausedSchema,
  });

  const create = createTool({
    name: 'workflows-create',
    description:
      'Create a workflow: a JSON file of a trigger and steps that Bureau runs. `name` is what the workflow is called, and its identifier is derived from it (lowercase, with runs of other characters turned into one hyphen) unless you give `id`. A taken identifier is a conflict. The workflow is yours to change and starts working as soon as the call returns.',
    input: createInput,
    metadata: {
      shortDescription: 'Create a workflow Bureau runs on a schedule or a signal.',
    },
    execute: async (input, context): Promise<WorkflowToolResult> => {
      const derived = input.id === undefined ? deriveWorkflowIdentifier(input.name) : undefined;
      const provisional =
        input.id ?? (derived !== undefined && 'id' in derived ? derived.id : input.name);
      const calling = await caller(context, provisional);
      if ('refusal' in calling) return calling.refusal;
      if (derived !== undefined && 'message' in derived) {
        return {
          status: 'invalid',
          code: 'invalid-identifier',
          issues: [{ path: 'name', message: derived.message }],
        };
      }
      try {
        return {
          status: 'ok',
          ...(await calling.workflows.create(provisional, definition(calling.agent, input), {
            actor: calling.actor,
          })),
        };
      } catch (error) {
        return resultOfFailure(error, provisional);
      }
    },
  });

  const update = createTool({
    name: 'workflows-update',
    description:
      'Replace a workflow with a new trigger and steps, if its file still has the `hash` workflows-list returned. The whole definition is replaced, description included, and you become the agent that wrote it. Pass back the `description` workflows-list returned to keep it; leave it out for none, and `paused` out to leave the workflow running.',
    input: updateInput,
    metadata: { shortDescription: 'Replace a workflow’s trigger and steps.' },
    execute: async (input, context): Promise<WorkflowToolResult> => {
      const calling = await caller(context, input.id);
      if ('refusal' in calling) return calling.refusal;
      try {
        return {
          status: 'ok',
          ...(await calling.workflows.update(input.id, definition(calling.agent, input), {
            expectedHash: input.expectedHash,
            actor: calling.actor,
          })),
        };
      } catch (error) {
        return resultOfFailure(error, input.id);
      }
    },
  });

  function guarded(name: 'workflows-pause' | 'workflows-resume', paused: boolean) {
    return createTool({
      name,
      description: paused
        ? 'Pause a workflow, if its file still has the `hash` workflows-list returned. A paused workflow starts nothing new; instances already running finish.'
        : 'Resume a paused workflow, if its file still has the `hash` workflows-list returned.',
      input: guardedInput,
      metadata: {
        shortDescription: paused
          ? 'Pause a workflow so it starts nothing new.'
          : 'Resume a paused workflow.',
      },
      execute: async (input, context): Promise<WorkflowToolResult> => {
        const calling = await caller(context, input.id);
        if ('refusal' in calling) return calling.refusal;
        const guard = { expectedHash: input.expectedHash, actor: calling.actor };
        try {
          return {
            status: 'ok',
            ...(await (paused
              ? calling.workflows.pause(input.id, guard)
              : calling.workflows.resume(input.id, guard))),
          };
        } catch (error) {
          return resultOfFailure(error, input.id);
        }
      },
    });
  }

  const list = createTool({
    name: 'workflows-list',
    description:
      'List the workflows: each one’s identifier, the `hash` the other workflow tools take as `expectedHash`, its state, whether it is paused, its trigger kind, and its description (pass it back to workflows-update to keep it, because an update replaces the whole definition). A file that cannot run is listed with a null trigger kind and the problem, so you can fix it.',
    input: z.object({}),
    metadata: { shortDescription: 'List the workflows and their state.' },
    execute: async (_input, context): Promise<WorkflowToolResult | WorkflowToolListResult> => {
      const calling = await caller(context, '');
      if ('refusal' in calling) {
        // Nothing to hide for a caller that is not the owner: it sees no workflows at all. A caller
        // that is the owner but has no usable identifier is told why.
        return calling.refusal.status === 'not-found'
          ? { status: 'ok', workflows: [] }
          : calling.refusal;
      }
      return {
        status: 'ok',
        workflows: calling.workflows.list().map((listing): WorkflowToolListing => ({
          id: listing.id,
          hash: listing.hash ?? null,
          state: listing.state,
          paused: listing.paused,
          triggerKind: listing.triggerKind,
          description: listing.description,
          problem: listing.problem?.code ?? null,
        })),
      };
    },
  });

  return {
    [create.name]: create,
    [update.name]: update,
    'workflows-pause': guarded('workflows-pause', true),
    'workflows-resume': guarded('workflows-resume', false),
    [list.name]: list,
  };
}
