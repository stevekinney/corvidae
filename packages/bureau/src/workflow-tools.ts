/**
 * The tools an agent manages its workflows with (COR-1529): `workflows-create`, `workflows-update`,
 * `workflows-pause`, `workflows-resume`, `workflows-list`, `workflows-get`,
 * `workflows-revisions-list`, and `workflows-revisions-get`. The built-in `bureau` plugin
 * contributes them when `workflowSource` is set (COR-1890), so an agent file receives them only when
 * it lists them in `tools` as `bureau:workflows-create` and so on, and a provider calls them
 * `bureau__workflows-create`. They write through `Bureau.workflows`, the same operations HTTP callers
 * use, never to the filesystem directly.
 *
 * Every workflow belongs to the deployment's owner of record. A tool acts only when the owner of
 * record of the run that called it, read through the shared run authority and not from anything
 * the request carried, is that owner; for any other run `workflows-list` is empty and every write
 * answers `not-found`, as if no workflow existed. The `agent` field of a file a tool writes is the
 * calling run's own agent identifier.
 *
 * Every outcome is an ordinary tool result, never a thrown error, so a conflict or a document that
 * would not load reaches the model as something it can read and correct.
 *
 * @module workflow-tools
 */

import { createTool, type Tool, type ToolContext } from 'armorer';
import type { WorkflowStatus } from '@lostgradient/weft';
import { z } from 'zod';

import { AGENT_IDENTIFIER_PATTERN } from './agent-file';
import { BUREAU_PLUGIN_NAME } from './plugins/bureau-plugin';
import { mayRunUseSharedConfiguration } from './run-authority.ts';
import type { WorkspaceRuntimeAuthority } from './http/workspace-principal.ts';
import {
  checkWorkflowIdentifier,
  type WorkflowFileDefinition,
  WorkflowFileConflictError,
  WorkflowFileError,
  serializeWorkflowFile,
} from './workflow-file';
import { type BureauWorkflows, WorkflowApplyError } from './workflow-runtime';
import { WorkflowInputInvalidError } from './workflow-schema.ts';

/**
 * The names of the workflow tools within the `bureau` plugin. Hyphens, because provider tool-name
 * grammars exclude dots.
 */
export const WORKFLOW_TOOL_NAMES = [
  'workflows-create',
  'workflows-update',
  'workflows-propose-update',
  'workflows-validate',
  'workflows-catalog',
  'workflows-pause',
  'workflows-resume',
  'workflows-list',
  'workflows-get',
  'workflows-revisions-list',
  'workflows-revisions-get',
  'workflows-start',
  'workflows-signal',
  'workflows-runs-cancel',
  'workflows-runs-list',
  'workflows-runs-get',
  'workflows-runs-history',
] as const;

const WORKFLOW_RUN_STATUS_INPUTS = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'canceled',
  'timed-out',
  'suspended',
] as const;
const workflowRunStatusInput = z.enum(WORKFLOW_RUN_STATUS_INPUTS);

function workflowRunStatus(value: (typeof WORKFLOW_RUN_STATUS_INPUTS)[number]): WorkflowStatus {
  return value === 'canceled' ? 'cancelled' : value;
}

/** What the tools read from the Bureau that owns them. */
export interface WorkflowToolHost {
  readonly workspace?: WorkspaceRuntimeAuthority | undefined;
  /** The workflow files. Read on every call, because the tools exist before the runtime does. */
  readonly workflows: () => BureauWorkflows | undefined;
  /**
   * The agent identifier of a run, its owner of record, and the hook that started it (or the run
   * above it), for the run that made a tool call. `hookOrigin` is what a workflow the tool writes
   * carries onto its schedule (COR-1952), so that schedule's fires start no `start-workflow` hook.
   */
  readonly runIdentity: (runId: string) => Promise<{
    readonly agent: string | undefined;
    readonly owner: string | undefined;
    readonly hookOrigin?: string | undefined;
  }>;
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
  | {
      readonly status: 'ok';
      readonly id: string;
      readonly baseHash: string;
      readonly proposedText: string;
    }
  | { readonly status: 'forbidden'; readonly message: string }
  | {
      readonly status: 'ok';
      readonly stepKinds: readonly {
        readonly kind: string;
        readonly fields: Readonly<Record<string, unknown>>;
      }[];
      readonly activities: readonly {
        readonly id: string;
        /** What the editor calls the activity: a plugin activity's required `title`; fixed for `agent`. */
        readonly title: string | null;
        readonly description: string | null;
        readonly inputSchema: Readonly<Record<string, unknown>> | null;
      }[];
      readonly triggers: readonly {
        readonly id: string;
        readonly description: string;
        readonly configuration: Readonly<Record<string, unknown>> | null;
      }[];
    }
  | { readonly status: 'unavailable'; readonly reason: 'workflow-apply-failed' };

/** A parsed workflow document returned by `workflows-get` or `workflows-revisions-get`. */
export interface WorkflowToolDocument {
  readonly name: string;
  readonly trigger: Record<string, unknown>;
  readonly steps: readonly Record<string, unknown>[];
  readonly activityVersions?: Readonly<Record<string, string>> | undefined;
  readonly inputSchema?: Readonly<Record<string, unknown>> | undefined;
  readonly outputSchema?: Readonly<Record<string, unknown>> | undefined;
}

/** One revision returned by the workflow revision tools. */
export interface WorkflowToolRevision {
  readonly workflowVersion: string;
  readonly firstRunAt: string;
  readonly lastRunAt: string;
  readonly compatibility: unknown;
}

/** One workflow as `workflows-list` shows it. */
export interface WorkflowToolListing {
  readonly id: string;
  /** The hash `expectedHash` is set to by the tools that change the file; `null` when unreadable. */
  readonly hash: string | null;
  readonly state: 'ready' | 'invalid';
  readonly paused: boolean;
  /** The trigger's `kind`, or `null` for an `invalid` file. */
  readonly triggerKind: string | null;
  /** The workflow's title, or `null` when it has none; passed back like `description`. */
  readonly title: string | null;
  /**
   * What the workflow is for, or `null` when it has none. `workflows-update` replaces the whole
   * definition, so an agent that updates a workflow passes this back to keep it.
   */
  readonly description: string | null;
  /**
   * The JSON Schema the workflow’s input must satisfy, or `null` when it declares none.
   * `workflows-update` replaces the whole definition, so an agent that updates a workflow passes
   * this back to keep it.
   */
  readonly inputSchema: Readonly<Record<string, unknown>> | null;
  /** The JSON Schema the workflow’s result must satisfy, or `null`; passed back like `inputSchema`. */
  readonly outputSchema: Readonly<Record<string, unknown>> | null;
  /** Why an `invalid` file cannot run, so its author can fix it; `null` for a ready one. */
  readonly problem: string | null;
}

/**
 * A code workflow a plugin contributed, as `workflows-list` shows it: an explicit `kind`, and none
 * of a file's members. It starts through `workflows-start` like a file.
 */
export interface WorkflowToolCodeListing {
  readonly kind: 'code';
  /** `plugin:name`. */
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly plugin: string;
  readonly version: string;
}

/** What `workflows-list` answers: the same `status` as every tool, and the workflows. */
export interface WorkflowToolListResult {
  readonly status: 'ok';
  readonly workflows: readonly (WorkflowToolListing | WorkflowToolCodeListing)[];
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
    'When the workflow starts: { "kind": "schedule", "spec": "0 6 * * *" } for a cron expression or a duration such as "1h", with an optional "name" (the schedule’s display name, such as "Morning digest"), "timezone" (an IANA zone such as "America/Chicago", for a cron expression), "overlap" ("skip", "queue", "cancel-running", or "allow"), "catchUp" (true to run what was missed while Bureau was off) and "input" (the fixed value every fire starts the workflow with, which inputSchema must accept); { "kind": "signal", "name": "..." } to start when that signal is sent; or { "kind": "manual" } for a workflow that only starts when someone starts it.',
  );

const stepsSchema = z
  .array(z.record(z.string(), z.unknown()))
  .describe(
    'The steps, run in order: { "kind": "activity", "handler": "agent", "input": { "agent": "...", "message": "..." } }, { "kind": "sleep", "duration": "5m" }, or { "kind": "await-signal", "signal": "..." }. Give each step a "title", the name a person reads. An await-signal step with "review": true waits for a person and shows in Reviews; without it, it waits for an outside signal.',
  );

const titleSchema = z
  .string()
  .optional()
  .describe(
    'The name a person reads, shown as the workflow’s heading with its identifier beside it. Leave it out to show the identifier.',
  );

const descriptionSchema = z
  .string()
  .optional()
  .describe(
    'One sentence on what the workflow is for, shown beside its name in the workflow list. Leave it out for none.',
  );

const inputSchemaSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    'A JSON Schema (draft 2020-12) for the input an instance starts with: what a signal carries as its payload or a person gives when they start it; a schedule starts with its trigger’s "input", or null when it gives none, and the schema must accept that. At most 32 KiB and 8 levels deep, with no $id, pattern, or patternProperties. Leave it out for none. An input that breaks it starts nothing.',
  );

const outputSchemaSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    'A JSON Schema (draft 2020-12) for the value an instance finishes with, under the same limits. The result of the last step is an agent step’s { content, output, finishReason }. An instance whose result breaks it fails with output-invalid. Leave it out for none.',
  );

const pausedSchema = z
  .boolean()
  .optional()
  .describe('Whether the workflow starts nothing new. Leave it out to leave the workflow running.');

const expectedHashSchema = z
  .string()
  .min(1)
  .describe(
    'The `hash` bureau__workflows-list returned for this workflow; a file that changed since is a conflict.',
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

function documentOf(document: WorkflowToolDocument): WorkflowToolDocument {
  return {
    name: document.name,
    trigger: { ...document.trigger },
    steps: document.steps.map((step) => ({ ...step })),
    ...(document.activityVersions === undefined
      ? {}
      : { activityVersions: { ...document.activityVersions } }),
    ...(document.inputSchema === undefined ? {} : { inputSchema: { ...document.inputSchema } }),
    ...(document.outputSchema === undefined ? {} : { outputSchema: { ...document.outputSchema } }),
  };
}

function revisionOf(revision: {
  readonly workflowVersion: string;
  readonly firstRunAt: string;
  readonly lastRunAt: string;
  readonly compatibility: unknown;
}): WorkflowToolRevision {
  return {
    workflowVersion: revision.workflowVersion,
    firstRunAt: revision.firstRunAt,
    lastRunAt: revision.lastRunAt,
    compatibility:
      revision.compatibility === null ||
      (revision.compatibility as { readonly compatible?: boolean }).compatible === true
        ? revision.compatibility
        : revision.compatibility === undefined
          ? null
          : {
              compatible: false,
              reasons: [
                ...((revision.compatibility as { readonly reasons: readonly string[] }).reasons ??
                  []),
              ],
            },
  };
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

function inputIssuesOf(error: WorkflowInputInvalidError): readonly WorkflowToolIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/** The identifier of the run that made `context`'s call, when it carries one. */
export function runIdOf(context: ToolContext | undefined): string | undefined {
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
    operationScope: 'bureau.workflows:read' | 'bureau.workflows:write',
  ): Promise<
    | {
        readonly workflows: BureauWorkflows;
        readonly agent: string;
        readonly actor: string;
        readonly owner: string | undefined;
        readonly hookOrigin: string | undefined;
        readonly runId: string;
      }
    | { readonly refusal: WorkflowToolResult }
  > {
    const workflows = host.workflows();
    const runId = runIdOf(context);
    const identity = runId === undefined ? undefined : await host.runIdentity(runId);
    if (
      workflows === undefined ||
      runId === undefined ||
      identity === undefined ||
      !(await mayRunUseSharedConfiguration(
        host.workspace,
        identity.owner,
        operationScope,
        operationScope === 'bureau.workflows:write',
        workflows.owner,
        {
          allowOperatorScope: false,
        },
      ))
    ) {
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
    return {
      workflows,
      agent,
      actor: `agent-run:${runId}`,
      owner: identity.owner,
      hookOrigin: identity.hookOrigin,
      runId,
    };
  }

  const definition = (agent: string, input: Record<string, unknown>): WorkflowFileDefinition => {
    const { name: _name, id: _id, expectedHash: _expectedHash, ...candidate } = input;
    return {
      ...candidate,
      agent,
      trigger: candidate['trigger'] as WorkflowFileDefinition['trigger'],
      steps: candidate['steps'] as WorkflowFileDefinition['steps'],
    };
  };

  const createInput = z.looseObject({
    name: z.string().min(1).describe('What the workflow is called.'),
    id: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The identifier, lowercase letters, digits, and hyphens, starting with a letter and at most 64 characters. Derived from `name` when you leave it out.',
      ),
    title: titleSchema,
    description: descriptionSchema,
    inputSchema: inputSchemaSchema,
    outputSchema: outputSchemaSchema,
    trigger: triggerSchema,
    steps: stepsSchema,
    paused: pausedSchema,
  });
  const updateInput = z.looseObject({
    ...guardedInput.shape,
    title: titleSchema,
    description: descriptionSchema,
    inputSchema: inputSchemaSchema,
    outputSchema: outputSchemaSchema,
    trigger: triggerSchema,
    steps: stepsSchema,
    paused: pausedSchema,
  });
  const validateInput = z.looseObject({
    id: z
      .string()
      .min(1)
      .optional()
      .describe('The workflow identifier, or omit it for a new draft.'),
    expectedHash: expectedHashSchema.optional(),
    title: titleSchema,
    description: descriptionSchema,
    inputSchema: inputSchemaSchema,
    outputSchema: outputSchemaSchema,
    trigger: triggerSchema,
    steps: stepsSchema,
    paused: pausedSchema,
  });

  const validate = createTool({
    name: 'workflows-validate',
    version: '1.0.0',
    description: 'Validate a workflow draft without writing it or registering it with the engine.',
    input: validateInput,
    metadata: {
      readOnly: true,
      title: 'Validate workflow',
      shortDescription: 'Validate a workflow draft without saving it.',
    },
    execute: async (input, context): Promise<WorkflowToolResult> => {
      const id = input.id ?? 'draft';
      const calling = await caller(context, id, 'bureau.workflows:read');
      if ('refusal' in calling) {
        return calling.refusal.status === 'not-found'
          ? {
              status: 'forbidden',
              message: 'Workflow validation is unavailable to the current caller.',
            }
          : calling.refusal;
      }
      try {
        return {
          status: 'ok',
          ...(await calling.workflows.validate(
            input.id ?? 'draft',
            definition(calling.agent, input),
            input.expectedHash,
          )),
        };
      } catch (error) {
        return resultOfFailure(error, id);
      }
    },
  });

  const catalog = createTool({
    name: 'workflows-catalog',
    version: '1.0.0',
    description: 'List the workflow step, activity, and trigger kinds this deployment supports.',
    input: z.object({}),
    metadata: {
      readOnly: true,
      title: 'Catalog workflow kinds',
      shortDescription: 'List supported workflow kinds.',
    },
    execute: async (_input, context): Promise<WorkflowToolResult> => {
      const calling = await caller(context, '', 'bureau.workflows:read');
      if ('refusal' in calling) {
        return calling.refusal.status === 'not-found'
          ? {
              status: 'forbidden',
              message: 'The workflow catalog is unavailable to the current caller.',
            }
          : calling.refusal;
      }
      return { status: 'ok', ...calling.workflows.catalog() };
    },
  });

  const create = createTool({
    name: 'workflows-create',
    version: '1.0.0',
    description:
      'Create a workflow: a JSON file of a trigger and steps that Bureau runs. `name` is what the workflow is called, and its identifier is derived from it (lowercase, with runs of other characters turned into one hyphen) unless you give `id`. A taken identifier is a conflict. The workflow is yours to change and starts working as soon as the call returns.',
    input: createInput,
    metadata: {
      mutates: true,
      title: 'Create workflow',
      shortDescription: 'Create a workflow Bureau runs on a schedule or a signal.',
    },
    execute: async (input, context): Promise<WorkflowToolResult> => {
      const derived = input.id === undefined ? deriveWorkflowIdentifier(input.name) : undefined;
      const provisional =
        input.id ?? (derived !== undefined && 'id' in derived ? derived.id : input.name);
      const calling = await caller(context, provisional, 'bureau.workflows:write');
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
            hookOrigin: calling.hookOrigin,
            source: BUREAU_PLUGIN_NAME,
          })),
        };
      } catch (error) {
        return resultOfFailure(error, provisional);
      }
    },
  });

  const update = createTool({
    name: 'workflows-update',
    version: '1.0.0',
    description:
      'Replace a workflow with a new trigger and steps, if its file still has the `hash` bureau__workflows-list returned. The whole definition is replaced, description and schemas included, and you become the agent that wrote it. Pass back the `title`, `description`, `inputSchema`, and `outputSchema` workflows-list returned to keep them; leave one out for none, and `paused` out to leave the workflow running.',
    input: updateInput,
    metadata: {
      mutates: true,
      title: 'Update workflow',
      shortDescription: 'Replace a workflow’s trigger and steps.',
    },
    execute: async (input, context): Promise<WorkflowToolResult> => {
      const calling = await caller(context, input.id, 'bureau.workflows:write');
      if ('refusal' in calling) return calling.refusal;
      try {
        return {
          status: 'ok',
          ...(await calling.workflows.update(input.id, definition(calling.agent, input), {
            expectedHash: input.expectedHash,
            actor: calling.actor,
            hookOrigin: calling.hookOrigin,
            source: BUREAU_PLUGIN_NAME,
          })),
        };
      } catch (error) {
        return resultOfFailure(error, input.id);
      }
    },
  });

  const proposeUpdate = createTool({
    name: 'workflows-propose-update',
    version: '1.0.0',
    description:
      'Validate a proposed replacement for a workflow without saving it. The proposal is based on expectedHash and returns its canonical text for a person to review.',
    input: updateInput,
    metadata: {
      readOnly: true,
      title: 'Propose workflow revision',
      shortDescription: 'Validate a workflow revision without saving it.',
    },
    execute: async (input, context): Promise<WorkflowToolResult> => {
      const calling = await caller(context, input.id, 'bureau.workflows:read');
      if ('refusal' in calling) return calling.refusal;
      const current = await calling.workflows.get(input.id);
      if (current === undefined) return { status: 'not-found', id: input.id };
      if (current.hash !== input.expectedHash) {
        return {
          status: 'conflict',
          id: input.id,
          reason: 'workflow-file-changed',
          ...(current.hash === undefined ? {} : { currentHash: current.hash }),
        };
      }
      const proposed = definition(calling.agent, input);
      try {
        await calling.workflows.validate(input.id, proposed, input.expectedHash);
        return {
          status: 'ok',
          id: input.id,
          baseHash: current.hash,
          proposedText: serializeWorkflowFile(input.id, proposed),
        };
      } catch (error) {
        return resultOfFailure(error, input.id);
      }
    },
  });

  function guarded(name: 'workflows-pause' | 'workflows-resume', paused: boolean) {
    return createTool({
      name,
      version: '1.0.0',
      description: paused
        ? 'Pause a workflow, if its file still has the `hash` bureau__workflows-list returned. A paused workflow starts nothing new; instances already running finish.'
        : 'Resume a paused workflow, if its file still has the `hash` bureau__workflows-list returned.',
      input: guardedInput,
      metadata: {
        mutates: true,
        title: paused ? 'Pause workflow' : 'Resume workflow',
        shortDescription: paused
          ? 'Pause a workflow so it starts nothing new.'
          : 'Resume a paused workflow.',
      },
      execute: async (input, context): Promise<WorkflowToolResult> => {
        const calling = await caller(context, input.id, 'bureau.workflows:write');
        if ('refusal' in calling) return calling.refusal;
        const guard = {
          expectedHash: input.expectedHash,
          actor: calling.actor,
          source: BUREAU_PLUGIN_NAME,
        };
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
    version: '1.0.0',
    description:
      'List the workflows: each one’s identifier, the `hash` the other workflow tools take as `expectedHash`, its state, whether it is paused, its trigger kind, its title and description, and its `inputSchema` and `outputSchema` (pass them back to bureau__workflows-update to keep them, because an update replaces the whole definition). A file that cannot run is listed with a null trigger kind and the problem, so you can fix it. A workflow a plugin contributed in code is listed with `kind: "code"`, its `plugin` and `version`, and none of a file’s fields; start it with bureau__workflows-start.',
    input: z.object({}),
    metadata: {
      readOnly: true,
      title: 'List workflows',
      shortDescription: 'List the workflows and their state.',
    },
    execute: async (_input, context): Promise<WorkflowToolResult | WorkflowToolListResult> => {
      const calling = await caller(context, '', 'bureau.workflows:read');
      if ('refusal' in calling) {
        // Nothing to hide for a caller that is not the owner: it sees no workflows at all. A caller
        // that is the owner but has no usable identifier is told why.
        return calling.refusal.status === 'not-found'
          ? { status: 'ok', workflows: [] }
          : calling.refusal;
      }
      const code: readonly WorkflowToolCodeListing[] = calling.workflows
        .codeList()
        .map((listing) => ({ ...listing }));
      return {
        status: 'ok',
        workflows: [
          ...calling.workflows.list().map((listing): WorkflowToolListing => ({
            id: listing.id,
            hash: listing.hash ?? null,
            state: listing.state,
            paused: listing.paused,
            triggerKind: listing.triggerKind,
            title: listing.title,
            description: listing.description,
            inputSchema: listing.inputSchema,
            outputSchema: listing.outputSchema,
            problem: listing.problem?.code ?? null,
          })),
          ...code,
        ],
      };
    },
  });

  const get = createTool({
    name: 'workflows-get',
    version: '1.0.0',
    description:
      'Read a workflow file, including its hash, text, and parsed document. Pass the hash to workflows-update as expectedHash. An invalid file returns its text, hash, code, and issues so you can repair it.',
    input: z.object({ id: z.string().min(1).describe('The workflow identifier.') }),
    metadata: {
      readOnly: true,
      title: 'Read workflow',
      shortDescription: 'Read a workflow file and its parsed document.',
    },
    execute: async (input, context): Promise<WorkflowToolResult | Record<string, unknown>> => {
      const calling = await caller(context, input.id, 'bureau.workflows:read');
      if ('refusal' in calling) return calling.refusal;
      const detail = await calling.workflows.get(input.id);
      if (detail === undefined) {
        return { status: 'not-found', id: input.id };
      }
      if (detail.state === 'invalid') {
        return {
          status: 'invalid',
          id: input.id,
          hash: detail.hash,
          ...(detail.text === undefined ? {} : { text: detail.text }),
          code: detail.problem?.code ?? 'invalid-document',
          issues:
            detail.problem?.issues?.map((issue) => ({
              path: issue.path,
              message: issue.message,
            })) ??
            (detail.problem === undefined ? [] : [{ path: '$', message: detail.problem.message }]),
        };
      }
      return {
        status: 'ok',
        id: input.id,
        hash: detail.hash,
        text: detail.text,
        document: documentOf(detail.document!),
      };
    },
  });

  const revisionsList = createTool({
    name: 'workflows-revisions-list',
    version: '1.0.0',
    description:
      'List the workflow revisions that have run, with their run times and compatibility verdicts.',
    input: z.object({ id: z.string().min(1).describe('The workflow identifier.') }),
    metadata: {
      readOnly: true,
      title: 'List workflow revisions',
      shortDescription: 'List revisions that have run.',
    },
    execute: async (input, context): Promise<WorkflowToolResult | Record<string, unknown>> => {
      const calling = await caller(context, input.id, 'bureau.workflows:read');
      if ('refusal' in calling) {
        return calling.refusal.status === 'not-found'
          ? { status: 'ok', revisions: [] }
          : calling.refusal;
      }
      const revisions = await calling.workflows.revisions(
        input.id,
        host.workspace === undefined
          ? undefined
          : async (runId) => {
              if (calling.owner === undefined) return false;
              const identity = await host.runIdentity(runId);
              return identity.owner === calling.owner;
            },
      );
      if (revisions === undefined) return { status: 'not-found', id: input.id };
      return { status: 'ok', revisions: revisions.map(revisionOf) };
    },
  });

  const revisionsGet = createTool({
    name: 'workflows-revisions-get',
    version: '1.0.0',
    description:
      'Read one workflow revision that has run, including its document and compatibility verdict.',
    input: z.object({
      id: z.string().min(1).describe('The workflow identifier.'),
      workflowVersion: z.string().min(1).describe('The revision workflowVersion.'),
    }),
    metadata: {
      readOnly: true,
      title: 'Read workflow revision',
      shortDescription: 'Read a workflow revision document.',
    },
    execute: async (input, context): Promise<WorkflowToolResult | Record<string, unknown>> => {
      const calling = await caller(context, input.id, 'bureau.workflows:read');
      if ('refusal' in calling) return calling.refusal;
      const revisions = await calling.workflows.revisions(
        input.id,
        host.workspace === undefined
          ? undefined
          : async (runId) => {
              if (calling.owner === undefined) return false;
              const identity = await host.runIdentity(runId);
              return identity.owner === calling.owner;
            },
      );
      const revision = revisions?.find(
        (candidate) => candidate.workflowVersion === input.workflowVersion,
      );
      if (revision === undefined) return { status: 'not-found', id: input.id };
      return {
        status: 'ok',
        workflowVersion: revision.workflowVersion,
        document: documentOf(revision.document),
        compatibility: revision.compatibility,
      };
    },
  });

  const start = createTool({
    name: 'workflows-start',
    version: '1.0.0',
    description: 'Start a workflow file with JSON input and return its run identifier.',
    input: z.object({ id: z.string().min(1), input: z.json().optional() }),
    metadata: { mutates: true, title: 'Start workflow', shortDescription: 'Start a workflow run.' },
    execute: async (input, context) => {
      const calling = await caller(context, input.id, 'bureau.workflows:write');
      if ('refusal' in calling) return calling.refusal;
      try {
        return {
          status: 'ok' as const,
          ...(await calling.workflows.start(input.id, {
            input: input.input,
            owner: calling.owner ?? calling.workflows.owner,
            origin: { kind: 'agent-run' as const, runId: calling.runId, agentId: calling.agent },
          })),
        };
      } catch (error) {
        if (error instanceof WorkflowInputInvalidError)
          return { status: 'invalid' as const, code: error.code, issues: inputIssuesOf(error) };
        if (error instanceof WorkflowFileError && error.code === 'workflow-file-not-found')
          return { status: 'not-found' as const, id: input.id };
        if (error instanceof WorkflowFileError)
          return { status: 'invalid' as const, code: error.code, issues: issuesOf(error) };
        throw error;
      }
    },
  });

  const signal = createTool({
    name: 'workflows-signal',
    version: '1.0.0',
    description:
      'Deliver a named signal to waiting workflow runs and start matching signal workflows.',
    input: z.object({
      name: z.string().min(1),
      payload: z.json().optional(),
      signalId: z.string().min(1).optional(),
    }),
    metadata: {
      mutates: true,
      title: 'Signal workflows',
      shortDescription: 'Send a workflow signal.',
    },
    execute: async (input, context) => {
      const calling = await caller(context, '', 'bureau.workflows:write');
      if ('refusal' in calling)
        return { status: 'ok' as const, started: [], delivered: [], rejected: [] };
      const result = await calling.workflows.signal(input.name, input.payload ?? null, {
        signalId: input.signalId,
        owner: calling.owner,
        maySignalRun: async (runId) => {
          const identity = await host.runIdentity(runId);
          return identity.owner === calling.owner;
        },
      });
      return {
        status: 'ok' as const,
        started: result.started,
        delivered: result.delivered,
        rejected: result.rejected,
      };
    },
  });

  const runsList = createTool({
    name: 'workflows-runs-list',
    version: '1.0.0',
    description: 'List workflow-file runs owned by the calling run.',
    input: z.object({
      workflow: z.string().optional(),
      status: workflowRunStatusInput.optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    metadata: {
      readOnly: true,
      title: 'List workflow runs',
      shortDescription: 'List workflow runs.',
    },
    execute: async (input, context) => {
      const calling = await caller(context, '', 'bureau.workflows:read');
      if ('refusal' in calling) return { status: 'ok' as const, runs: [], nextOffset: null };
      const page = await calling.workflows.listRuns({
        workflow: input.workflow,
        status: input.status === undefined ? undefined : workflowRunStatus(input.status),
        limit: input.limit ?? 50,
        offset: input.offset ?? 0,
        mayReadRun: async (runId) => {
          const identity = await host.runIdentity(runId);
          return identity.owner === calling.owner;
        },
      });
      return { status: 'ok' as const, runs: page.runs, nextOffset: page.nextOffset };
    },
  });

  const runsGet = createTool({
    name: 'workflows-runs-get',
    version: '1.0.0',
    description: 'Read one workflow-file run owned by the calling run.',
    input: z.object({ runId: z.string().min(1) }),
    metadata: {
      readOnly: true,
      title: 'Read workflow run',
      shortDescription: 'Read a workflow run.',
    },
    execute: async (input, context) => {
      const calling = await caller(context, input.runId, 'bureau.workflows:read');
      if ('refusal' in calling) return calling.refusal;
      const identity = await host.runIdentity(input.runId);
      if (identity.owner !== calling.owner)
        return { status: 'not-found' as const, id: input.runId };
      const run = await calling.workflows.getRun(input.runId);
      return run === undefined
        ? { status: 'not-found' as const, id: input.runId }
        : { status: 'ok' as const, run };
    },
  });

  const runsCancel = createTool({
    name: 'workflows-runs-cancel',
    version: '1.0.0',
    description: 'Request cancellation of one workflow-file run.',
    input: z.object({ runId: z.string().min(1) }),
    metadata: {
      mutates: true,
      title: 'Cancel workflow run',
      shortDescription: 'Cancel a workflow run.',
    },
    execute: async (input, context) => {
      const calling = await caller(context, input.runId, 'bureau.workflows:write');
      if ('refusal' in calling) return calling.refusal;
      const identity = await host.runIdentity(input.runId);
      if (identity.owner !== calling.owner)
        return { status: 'not-found' as const, id: input.runId };
      try {
        await calling.workflows.cancel(input.runId);
        return { status: 'cancel-requested' as const, runId: input.runId };
      } catch (error) {
        if (error instanceof WorkflowFileError)
          return { status: 'not-found' as const, id: input.runId };
        throw error;
      }
    },
  });

  const runsHistory = createTool({
    name: 'workflows-runs-history',
    version: '1.0.0',
    description: 'Read bounded, sanitized step history for one workflow-file run.',
    input: z.object({
      runId: z.string().min(1),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    metadata: {
      readOnly: true,
      title: 'Read workflow history',
      shortDescription: 'Read workflow step history.',
    },
    execute: async (input, context) => {
      const calling = await caller(context, input.runId, 'bureau.workflows:read');
      if ('refusal' in calling) return calling.refusal;
      const identity = await host.runIdentity(input.runId);
      if (identity.owner !== calling.owner)
        return { status: 'not-found' as const, id: input.runId };
      const history = await calling.workflows.historyRuns(input.runId, input.limit ?? 100);
      return history === undefined
        ? { status: 'not-found' as const, id: input.runId }
        : { status: 'ok' as const, ...history };
    },
  });

  return {
    [create.name]: create,
    [update.name]: update,
    [proposeUpdate.name]: proposeUpdate,
    [validate.name]: validate,
    [catalog.name]: catalog,
    'workflows-pause': guarded('workflows-pause', true),
    'workflows-resume': guarded('workflows-resume', false),
    [list.name]: list,
    [get.name]: get,
    [revisionsList.name]: revisionsList,
    [revisionsGet.name]: revisionsGet,
    [start.name]: start,
    [signal.name]: signal,
    [runsList.name]: runsList,
    [runsGet.name]: runsGet,
    [runsCancel.name]: runsCancel,
    [runsHistory.name]: runsHistory,
  };
}
