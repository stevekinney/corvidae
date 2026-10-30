/**
 * `bureau.workflows.*`: the agent-authored workflow files of a Bureau (COR-1527), written, read,
 * paused, resumed, and deleted through the same JSON files a person edits by hand, and the
 * instances those workflows have run.
 *
 * Every workflow file belongs to the deployment's owner of record, and there is no owner field in
 * a file. A caller reaches workflows it owns without any scope; `bureau.workflows:read` grants
 * `get`, `list`, `revisions`, `runs.list`, and `runs.get` to any caller, and
 * `bureau.workflows:write` grants `create`, `update`, `pause`, `resume`, and `delete`, and neither
 * implies the other. A caller that may not see workflows is answered as if there were none: an
 * empty page, or `NotFound`. `create` has no workflow to hide, so a caller who may not write is
 * refused with `Forbidden`.
 *
 * A write fails with a typed `Conflict` (`data.reason` is `workflow-file-exists`) when the
 * identifier is taken, with `StaleRevision` (`data.currentRevision` is the hash of what is on disk)
 * when the file changed since the caller read it, and with `Unprocessable` (`data.reason` is the
 * problem code) when the result would not load; each writes nothing. A write that reached the file
 * but whose effect on the engine or the schedule failed is `Unavailable` (`data.reason` is
 * `workflow-apply-failed`): the file holds the change and the next rescan applies it again.
 *
 * A workflow file may declare an `inputSchema` and an `outputSchema` (COR-1812), JSON Schemas for
 * what an instance starts with and finishes with. `bureau.workflows.start` starts one instance of
 * a named workflow and refuses an input that breaks the schema with `InvalidParams` and the
 * issues, creating nothing; `bureau.workflows.signal` starts nothing for a workflow whose schema
 * the payload breaks and reports it in `rejected`; an instance whose result breaks the
 * `outputSchema` fails with `finishReason: "output-invalid"`. A raw `weft.workflows.start` is not
 * checked before the instance exists, but the instance then fails with `input-invalid` as it
 * begins. `bureau.workflows.internal.get` reads a code-defined workflow's description and
 * source (its description and registered contract), under the same read rule as `get`.
 *
 * `bureau.workflows.signal` (COR-1528) is the one operation that names no workflow: it delivers a
 * signal to the running instances waiting for it and starts the workflows whose signal trigger
 * has that name, and a caller who may not write is answered as if nothing matched.
 *
 * @module workflows-operations
 */

import {
  defineOperation,
  type OperationFault,
  type Principal,
  type WorkflowCompatibilityReason,
} from '@lostgradient/weft';
import { z } from 'zod';

import { ownerOrLocal } from '../../owner-of-record.ts';
import { SIGNAL_NAME_MAXIMUM_LENGTH } from '../../workflow-host.ts';
import { BureauError } from '../../create-bureau.ts';
import { WorkflowFileConflictError, WorkflowFileError } from '../../workflow-file.ts';
import {
  type BureauWorkflows,
  SIGNAL_ID_MAXIMUM_BYTES,
  WorkflowApplyError,
  WorkflowSignalFailure,
} from '../../workflow-runtime.ts';
import { TASK_PERSON_SURFACES } from '../../task-origin.ts';
import { WorkflowInputInvalidError } from '../../workflow-schema.ts';
import type { BureauScope } from '../bureau-scopes.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import {
  DEFAULT_PAGE_LIMIT,
  pageFields,
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** What the workflow operations read from the handler's `host`. */
export type BureauWorkflowsOperationHost = BureauOwnershipHost & {
  readonly workflows: BureauWorkflows | undefined;
};

const workflowIdentifier = z.string().min(1).max(256);
const workflowId = workflowIdentifier.describe('The identifier of the workflow.');
const hash = z
  .string()
  .min(1)
  .describe(
    'The `hash` of the workflow file the caller read; a file that has changed since is a `StaleRevision` fault and nothing is written.',
  );

const problemSchema = z.object({
  code: z.string(),
  message: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).nullable(),
});

/** A JSON Schema as it is written in a workflow file. */
const jsonSchemaField = z.record(z.string(), z.unknown());

const workflowListingSchema = z.object({
  id: z.string(),
  state: z.enum(['ready', 'invalid']),
  owner: z.string(),
  hash: z.string().nullable(),
  description: z.string().nullable(),
  agent: z.string().nullable(),
  paused: z.boolean(),
  /** The JSON Schema an instance's input must satisfy, or `null` when the file declares none. */
  inputSchema: jsonSchemaField.nullable(),
  /** The JSON Schema an instance's result must satisfy, or `null` when the file declares none. */
  outputSchema: jsonSchemaField.nullable(),
  version: z.string().nullable(),
  /** The file's trigger as written, `{ kind, ... }`, for a `ready` file, else `null`. */
  trigger: z.record(z.string(), z.unknown()).nullable(),
  problem: problemSchema.nullable(),
});

const scheduleSchema = z.object({
  id: z.string(),
  status: z.enum(['active', 'paused']),
  nextFireAt: z.string().nullable(),
});

/** How busy a workflow is: see `WorkflowRunCounts`. */
const runCountsSchema = z.object({
  active: z.number().int(),
  last24Hours: z.number().int(),
  lastRunAt: z.string().nullable(),
});

const workflowDetailSchema = workflowListingSchema.extend({
  text: z.string().nullable(),
  schedule: scheduleSchema.nullable(),
});

/**
 * Strict, because Zod strips an undeclared key from a plain `z.object` and Weft's `unknownKeyPolicy`
 * reaches only the payload's top level: a key such as `retries` would vanish and the write would
 * still succeed (COR-1595). `trigger` stays loose, so the registered kind's own validator refuses
 * the keys that kind does not declare.
 */
const definitionSchema = z
  .strictObject({
    description: z.string().optional(),
    agent: z.string().optional(),
    paused: z.boolean().optional(),
    inputSchema: jsonSchemaField
      .optional()
      .describe(
        'A JSON Schema (draft 2020-12) for the input an instance starts with: the `input` of `bureau.workflows.start` or the `payload` of a signal; a schedule fire starts with `null`. At most 32 KiB, 8 levels deep, with no `$id`, `pattern`, or `patternProperties`.',
      ),
    outputSchema: jsonSchemaField
      .optional()
      .describe(
        'A JSON Schema (draft 2020-12) for the value an instance finishes with, under the same limits. An instance whose result breaks it fails with `output-invalid`.',
      ),
    trigger: z.looseObject({ kind: z.string() }),
    steps: z.array(z.record(z.string(), z.unknown())),
  })
  .describe(
    'The workflow file’s contents: an optional `description`, `agent` and `paused`, optional `inputSchema` and `outputSchema`, the `trigger` (an object with a `kind`), and the `steps`.',
  );

const writeResultSchema = z.object({ id: z.string(), hash: z.string() });

const runStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed-out',
  'suspended',
]);

const runSummarySchema = z.object({
  id: z.string(),
  workflow: z.string(),
  workflowVersion: z.string(),
  status: runStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

const runDetailSchema = runSummarySchema.extend({
  trigger: z.json().nullable(),
  result: z.json().nullable(),
  error: z.string().nullable(),
  /**
   * `input-invalid` or `output-invalid` when the instance failed because its input or result broke
   * the workflow’s schema (`error` lists the issues), else `null`.
   */
  finishReason: z.enum(['input-invalid', 'output-invalid']).nullable(),
});

const documentSchema = z.object({
  name: z.string(),
  trigger: z.record(z.string(), z.unknown()),
  steps: z.array(z.record(z.string(), z.unknown())),
  inputSchema: jsonSchemaField.nullable(),
  outputSchema: jsonSchemaField.nullable(),
});

function unsupported(): OperationFault {
  return {
    code: 'UnsupportedCapability',
    message: 'This Bureau has no workflow directory, so it has no workflows',
    data: { capability: 'workflow-directory' },
  };
}

function workflowsOf(host: BureauWorkflowsOperationHost): BureauWorkflows {
  if (host.workflows === undefined) throw unsupported();
  return host.workflows;
}

/** Every workflow file belongs to the deployment's owner of record, whether or not a directory is configured. */
const DEPLOYMENT_OWNER = ownerOrLocal(undefined);

function mayAccessWorkflows(
  host: BureauWorkflowsOperationHost,
  principal: Principal,
  operatorScope: BureauScope,
): boolean {
  return host.ownership.mayAccess({ principal, resourceOwner: DEPLOYMENT_OWNER, operatorScope });
}

/**
 * The workflows of the Bureau, for a caller who may use `operatorScope` on them. A caller who may
 * not is answered as if the workflow were missing, before anything is said about whether this
 * Bureau has a workflow directory at all.
 */
function workflowsFor(
  host: BureauWorkflowsOperationHost,
  principal: Principal,
  operatorScope: BureauScope,
  resource: 'workflow' | 'run',
  identifier: string,
): BureauWorkflows {
  if (!mayAccessWorkflows(host, principal, operatorScope))
    throw resourceNotFound(resource, identifier);
  return workflowsOf(host);
}

function listingView(listing: ReturnType<BureauWorkflows['list']>[number]) {
  return {
    id: listing.id,
    state: listing.state,
    owner: listing.owner,
    hash: listing.hash ?? null,
    description: listing.description,
    agent: listing.agent,
    paused: listing.paused,
    inputSchema: listing.inputSchema === null ? null : { ...listing.inputSchema },
    outputSchema: listing.outputSchema === null ? null : { ...listing.outputSchema },
    version: listing.version ?? null,
    trigger: listing.trigger === null ? null : { ...listing.trigger },
    problem:
      listing.problem === undefined
        ? null
        : {
            code: listing.problem.code,
            message: listing.problem.message,
            issues: listing.problem.issues?.map((issue) => ({ ...issue })) ?? null,
          },
  };
}

/**
 * The fault a failed read or write of a workflow file is answered with, or rethrows `error`.
 *
 * Weft's `Conflict` fault carries a `reason` and nothing else, so the hash a stale write needs to
 * retry travels in `StaleRevision`, the fault Weft defines for exactly that: `expectedRevision` is
 * the hash the caller sent and `currentRevision` the hash now on disk. A taken identifier is a
 * `Conflict` with `reason: 'workflow-file-exists'`.
 */
function faultOf(error: unknown, id: string, expectedHash?: string): never {
  if (error instanceof WorkflowFileConflictError) {
    if (error.code === 'workflow-file-changed' && error.currentHash !== undefined) {
      throw {
        code: 'StaleRevision',
        message: error.message,
        data: {
          ...(expectedHash === undefined ? {} : { expectedRevision: expectedHash }),
          currentRevision: error.currentHash,
        },
      } satisfies OperationFault;
    }
    throw {
      code: 'Conflict',
      message: error.message,
      data: { reason: error.code },
    } satisfies OperationFault;
  }
  if (error instanceof WorkflowApplyError) {
    throw {
      code: 'Unavailable',
      message: error.message,
      data: { reason: error.code },
    } satisfies OperationFault;
  }
  if (error instanceof WorkflowFileError) {
    if (error.code === 'workflow-file-not-found') throw resourceNotFound('workflow', id);
    if (error.code === 'invalid-identifier') {
      throw {
        code: 'InvalidParams',
        message: error.message,
        data: { issues: [{ path: ['id'], message: error.message, code: 'custom' }] },
      } satisfies OperationFault;
    }
    throw {
      code: 'Unprocessable',
      message: error.message,
      data: { reason: error.code },
    } satisfies OperationFault;
  }
  throw error;
}

const createInput = z.object({ id: workflowId, definition: definitionSchema });

export const workflowsCreateOperation = defineOperation<
  typeof createInput,
  typeof writeResultSchema,
  BureauWorkflowsOperationHost
>({
  name: 'bureau.workflows.create',
  mcpExposable: false,
  summary: 'Create a workflow file',
  description:
    'Writes a new workflow file for `id`, the workflow’s identifier: a lowercase letter, then letters, digits, and hyphens, at most 64 characters. `definition` is the workflow document without its `name` (Bureau sets it to `id`) plus the optional `description` (a sentence on what the workflow is for), the optional `agent` that wrote it, and `paused`. The file is written to a temporary file and renamed into place, and the workflow is registered and its schedule created before the call returns. Requires `bureau.workflows:write` unless the caller owns the deployment’s workflows. A taken identifier is a `Conflict` (`workflow-file-exists`); a document that would not load is `Unprocessable`, its message listing every issue, and nothing is written.',
  destructive: true,
  tags: ['Workflows'],
  inputSchema: createInput,
  outputSchema: writeResultSchema,
  producibleFaults: [
    'InvalidParams',
    'Forbidden',
    'Conflict',
    'Unprocessable',
    'Unavailable',
    'UnsupportedCapability',
  ],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    if (!mayAccessWorkflows(host, principal, 'bureau.workflows:write')) {
      throw {
        code: 'Forbidden',
        message: 'Creating a workflow requires bureau.workflows:write',
        data: { reason: 'missing scope bureau.workflows:write' },
      } satisfies OperationFault;
    }
    const workflows = workflowsOf(host);
    try {
      return await workflows.create(input.id, input.definition, {
        actor: ownerOfPrincipal(principal),
      });
    } catch (error) {
      return faultOf(error, input.id);
    }
  },
});

const updateInput = z.object({
  id: workflowId,
  expectedHash: hash,
  definition: definitionSchema,
});

export const workflowsUpdateOperation = defineOperation<
  typeof updateInput,
  typeof writeResultSchema,
  BureauWorkflowsOperationHost
>({
  name: 'bureau.workflows.update',
  mcpExposable: false,
  summary: 'Replace a workflow file',
  description:
    'Replaces the workflow file for `id` with `definition`, if it still hashes to `expectedHash` (the `hash` a read returned). A file that changed since is a `StaleRevision` fault whose `currentRevision` is the hash now on disk, and nothing is written. A definition that changes nothing writes nothing. Requires `bureau.workflows:write` unless the caller owns the deployment’s workflows; anyone else is answered `NotFound`.',
  destructive: true,
  tags: ['Workflows'],
  inputSchema: updateInput,
  outputSchema: writeResultSchema,
  producibleFaults: [
    'InvalidParams',
    'NotFound',
    'StaleRevision',
    'Unprocessable',
    'Unavailable',
    'UnsupportedCapability',
  ],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const workflows = workflowsFor(host, principal, 'bureau.workflows:write', 'workflow', input.id);
    try {
      return await workflows.update(input.id, input.definition, {
        expectedHash: input.expectedHash,
        actor: ownerOfPrincipal(principal),
      });
    } catch (error) {
      return faultOf(error, input.id, input.expectedHash);
    }
  },
});

const guardedInput = z.object({ id: workflowId, expectedHash: hash });

function defineGuardedWrite(
  name: string,
  summary: string,
  description: string,
  run: (
    workflows: BureauWorkflows,
    id: string,
    guard: { readonly expectedHash: string; readonly actor: string | undefined },
  ) => Promise<z.infer<typeof writeResultSchema>>,
) {
  return defineOperation<
    typeof guardedInput,
    typeof writeResultSchema,
    BureauWorkflowsOperationHost
  >({
    name,
    mcpExposable: false,
    summary,
    description,
    destructive: true,
    tags: ['Workflows'],
    inputSchema: guardedInput,
    outputSchema: writeResultSchema,
    producibleFaults: [
      'InvalidParams',
      'NotFound',
      'StaleRevision',
      'Unprocessable',
      'Unavailable',
      'UnsupportedCapability',
    ],
    access: { kind: 'authenticated' },
    discoverable: true,
    transports,
    unknownKeyPolicy,
    invoke: async ({ input, host, principal }) => {
      const workflows = workflowsFor(
        host,
        principal,
        'bureau.workflows:write',
        'workflow',
        input.id,
      );
      try {
        return await run(workflows, input.id, {
          expectedHash: input.expectedHash,
          actor: ownerOfPrincipal(principal),
        });
      } catch (error) {
        return faultOf(error, input.id, input.expectedHash);
      }
    },
  });
}

export const workflowsPauseOperation = defineGuardedWrite(
  'bureau.workflows.pause',
  'Pause a workflow',
  'Sets `paused: true` in the workflow’s file, if it still hashes to `expectedHash`, and pauses its schedule before the call returns. A paused workflow starts no new instance from its schedule; instances already running finish. Pausing adds no revision. Requires `bureau.workflows:write` unless the caller owns the deployment’s workflows.',
  (workflows, id, guard) => workflows.pause(id, guard),
);

export const workflowsResumeOperation = defineGuardedWrite(
  'bureau.workflows.resume',
  'Resume a workflow',
  'Sets `paused: false` in the workflow’s file, if it still hashes to `expectedHash`, and resumes its schedule before the call returns. Requires `bureau.workflows:write` unless the caller owns the deployment’s workflows.',
  (workflows, id, guard) => workflows.resume(id, guard),
);

export const workflowsDeleteOperation = defineGuardedWrite(
  'bureau.workflows.delete',
  'Delete a workflow file',
  'Deletes the workflow’s file, if it still hashes to `expectedHash`, and cancels its schedule before the call returns. Instances already running finish on the revision they began on, including after a restart; nothing new starts from the schedule. Requires `bureau.workflows:write` unless the caller owns the deployment’s workflows.',
  (workflows, id, guard) => workflows.delete(id, guard),
);

const getInput = z.object({ id: workflowId });

export const workflowsGetOperation = defineOperation<
  typeof getInput,
  typeof workflowDetailSchema,
  BureauWorkflowsOperationHost
>({
  name: 'bureau.workflows.get',
  mcpExposable: true,
  summary: 'Read one workflow',
  description:
    'Returns one workflow: whether its file is `ready` or `invalid` (with the `problem` that makes it so), the `hash` and `text` of the file for an editor that writes it back with `expectedHash`, its `description`, who wrote it, whether it is paused, its `trigger` as written, its Weft `version`, and its live `schedule`. Requires `bureau.workflows:read` unless the caller owns the deployment’s workflows; anyone else is answered `NotFound`.',
  destructive: false,
  tags: ['Workflows'],
  inputSchema: getInput,
  outputSchema: workflowDetailSchema,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const workflows = workflowsFor(host, principal, 'bureau.workflows:read', 'workflow', input.id);
    const detail = await workflows.get(input.id);
    if (detail === undefined) throw resourceNotFound('workflow', input.id);
    return { ...listingView(detail), text: detail.text ?? null, schedule: detail.schedule };
  },
});

const listInput = z.object({
  ...pageFields,
  includeRuns: z
    .boolean()
    .optional()
    .describe(
      'Counts each ready file’s instances. Off unless asked, because each count reads the engine.',
    ),
});
const listOutput = z.object({
  workflows: z.array(workflowListingSchema.extend({ runs: runCountsSchema.nullable() })),
  nextOffset: z.number().int().nullable(),
});

export const workflowsListOperation = defineOperation<
  typeof listInput,
  typeof listOutput,
  BureauWorkflowsOperationHost
>({
  name: 'bureau.workflows.list',
  mcpExposable: true,
  summary: 'List workflows',
  description:
    'Lists every workflow file by identifier, `ready` and `invalid` alike, each with its `description`, its `trigger`, and, when `includeRuns` is `true`, for a `ready` file its `runs`: how many instances are `active`, how many began in the last 24 hours, and when the newest began (`null` otherwise, because each count reads the engine, and `null` too for a file whose count the engine could not give, which never withholds the list). Pages with `limit` (1 to 100, default 50) and `offset`; `nextOffset` is `null` on the last page. A caller who does not own the deployment’s workflows and lacks `bureau.workflows:read` gets an empty page.',
  destructive: false,
  tags: ['Workflows'],
  inputSchema: listInput,
  outputSchema: listOutput,
  producibleFaults: ['InvalidParams', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    if (!mayAccessWorkflows(host, principal, 'bureau.workflows:read')) {
      return { workflows: [], nextOffset: null };
    }
    const workflows = workflowsOf(host);
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const offset = input.offset ?? 0;
    const all = workflows.list();
    const page = all.slice(offset, offset + limit);
    return {
      workflows: await Promise.all(
        page.map(async (listing) => ({
          ...listingView(listing),
          // A file the Bureau cannot use is never registered, so it has had no instance to count.
          runs:
            input.includeRuns === true && listing.state === 'ready'
              ? await workflows.runCounts(listing.id)
              : null,
        })),
      ),
      nextOffset: all.length > offset + limit ? offset + limit : null,
    };
  },
});

/** The five reasons Weft reports a revision incompatible; `satisfies` keeps the list equal to Weft's. */
const compatibilityReasons = [
  'name-mismatch',
  'manifest-version-unsupported',
  'contract-hash-mismatch',
  'workflow-version-incompatible',
  'artifact-revision-mismatch',
] as const satisfies readonly WorkflowCompatibilityReason[];

/** Weft's `WorkflowCompatibilityVerdict`, on the wire. */
const compatibilitySchema = z.discriminatedUnion('compatible', [
  z.object({ compatible: z.literal(true) }),
  z.object({
    compatible: z.literal(false),
    reasons: z
      .array(z.enum(compatibilityReasons))
      .describe('Every reason the revision is not compatible, in Weft’s fixed order.'),
  }),
]);

const revisionsOutput = z.object({
  revisions: z.array(
    z.object({
      workflowVersion: z.string(),
      firstRunAt: z.string(),
      lastRunAt: z.string(),
      document: documentSchema,
      /**
       * Weft's verdict for this revision against the workflow's current revision; `null` when the
       * workflow has no valid file now.
       */
      compatibility: compatibilitySchema.nullable(),
    }),
  ),
});

export const workflowsRevisionsOperation = defineOperation<
  typeof getInput,
  typeof revisionsOutput,
  BureauWorkflowsOperationHost
>({
  name: 'bureau.workflows.revisions',
  mcpExposable: false,
  summary: 'List the revisions of a workflow that have run',
  description:
    'Lists the revisions of the workflow’s document that have run, most recently run first, each with the document it ran and its `compatibility`: Weft’s verdict for that revision against the workflow’s current revision, `{ compatible: true }` or `{ compatible: false, reasons }` where `reasons` lists every applicable one of `name-mismatch`, `manifest-version-unsupported`, `contract-hash-mismatch`, `workflow-version-incompatible`, and `artifact-revision-mismatch`. The current revision is compatible with itself, and a revision whose document differs in any way carries at least `workflow-version-incompatible` and `artifact-revision-mismatch`, because a revision’s version and identity follow its content. `compatibility` is `null` when there is no current revision to compare against (the workflow was deleted, or its file is invalid). A revision is a document’s content, so pausing or resuming adds none, and a revision that was saved but never ran is not listed. Still answers for a deleted workflow whose revisions are stored. Requires `bureau.workflows:read` unless the caller owns the deployment’s workflows; anyone else, and an identifier with neither a file nor a stored revision, is answered `NotFound`.',
  destructive: false,
  tags: ['Workflows'],
  inputSchema: getInput,
  outputSchema: revisionsOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const workflows = workflowsFor(host, principal, 'bureau.workflows:read', 'workflow', input.id);
    const revisions = await workflows.revisions(input.id);
    if (revisions === undefined) throw resourceNotFound('workflow', input.id);
    return {
      revisions: revisions.map((revision) => ({
        workflowVersion: revision.workflowVersion,
        firstRunAt: revision.firstRunAt,
        lastRunAt: revision.lastRunAt,
        document: {
          name: revision.document.name,
          trigger: { ...revision.document.trigger },
          steps: revision.document.steps.map((step) => ({ ...step })),
          inputSchema:
            revision.document.inputSchema === undefined
              ? null
              : { ...revision.document.inputSchema },
          outputSchema:
            revision.document.outputSchema === undefined
              ? null
              : { ...revision.document.outputSchema },
        },
        compatibility:
          revision.compatibility === null
            ? null
            : revision.compatibility.compatible
              ? { compatible: true as const }
              : { compatible: false as const, reasons: [...revision.compatibility.reasons] },
      })),
    };
  },
});

const runsListInput = z.object({
  workflow: workflowIdentifier.optional().describe('Only the instances of this workflow.'),
  status: runStatusSchema.optional().describe('Only the instances in this status.'),
  ...pageFields,
});
const runsListOutput = z.object({
  runs: z.array(runSummarySchema),
  nextOffset: z.number().int().nullable(),
});

export const workflowsRunsListOperation = defineOperation<
  typeof runsListInput,
  typeof runsListOutput,
  BureauWorkflowsOperationHost
>({
  name: 'bureau.workflows.runs.list',
  mcpExposable: true,
  summary: 'List the instances of workflows',
  description:
    'Lists the instances (Weft runs) of the workflow files, newest first. `workflow` narrows to one workflow’s identifier and `status` to one status. Pages with `limit` (1 to 100, default 50) and `offset`; `nextOffset` is `null` on the last page. A caller who does not own the deployment’s workflows and lacks `bureau.workflows:read` gets an empty page.',
  destructive: false,
  tags: ['Workflows'],
  inputSchema: runsListInput,
  outputSchema: runsListOutput,
  producibleFaults: ['InvalidParams', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    if (!mayAccessWorkflows(host, principal, 'bureau.workflows:read')) {
      return { runs: [], nextOffset: null };
    }
    const workflows = workflowsOf(host);
    const page = await workflows.listRuns({
      workflow: input.workflow,
      status: input.status,
      limit: input.limit ?? DEFAULT_PAGE_LIMIT,
      offset: input.offset ?? 0,
    });
    return { runs: page.runs.map((run) => ({ ...run })), nextOffset: page.nextOffset };
  },
});

const runsGetInput = z.object({
  runId: z.string().min(1).describe('The identifier of the workflow instance to read.'),
});

export const workflowsRunsGetOperation = defineOperation<
  typeof runsGetInput,
  typeof runDetailSchema,
  BureauWorkflowsOperationHost
>({
  name: 'bureau.workflows.runs.get',
  mcpExposable: true,
  summary: 'Read one instance of a workflow',
  description:
    'Returns one instance: its workflow and revision, its status, what started it (`trigger`), its `result`, and, for an instance that failed, its `error`, including a failed `agent` step’s. `finishReason` is `input-invalid` or `output-invalid` for an instance that failed because its input or its result broke the workflow’s schema, and `null` for any other; the failed instance’s `error` lists the issues. Only an instance of a workflow file is readable here; any other run is answered `NotFound`, as is a caller who does not own the deployment’s workflows and lacks `bureau.workflows:read`.',
  destructive: false,
  tags: ['Workflows'],
  inputSchema: runsGetInput,
  outputSchema: runDetailSchema,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const workflows = workflowsFor(host, principal, 'bureau.workflows:read', 'run', input.runId);
    const run = await workflows.getRun(input.runId);
    if (run === undefined) throw resourceNotFound('run', input.runId);
    return {
      id: run.id,
      workflow: run.workflow,
      workflowVersion: run.workflowVersion,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      trigger: (run.trigger ?? null) as never,
      result: (run.result ?? null) as never,
      error: run.error ?? null,
      finishReason: run.finishReason,
    };
  },
});

const startInput = z.object({
  id: workflowId,
  input: z
    .json()
    .optional()
    .describe(
      'The input the workflow’s `inputSchema` describes; `null` when omitted. An input that breaks the schema is `InvalidParams`, its `data.issues` locating every failure, and no instance is created.',
    ),
  surface: z
    .enum(TASK_PERSON_SURFACES)
    .optional()
    .describe('Where the person started it from, recorded in the origin; `api` when omitted.'),
});
const startOutput = z.object({
  runId: z
    .string()
    .describe('The identifier of the new instance, for `bureau.workflows.runs.get`.'),
  workflow: z.string(),
  workflowVersion: z.string().describe('The revision the instance runs.'),
});

export const workflowsStartOperation = defineOperation<
  typeof startInput,
  typeof startOutput,
  BureauWorkflowsOperationHost
>({
  name: 'bureau.workflows.start',
  mcpExposable: false,
  summary: 'Start a workflow',
  description:
    'Starts one instance of the ready, unpaused workflow `id` with `input` and returns its `runId`. The instance’s `trigger` is `{ kind: "manual", input, origin }`, where `origin` is `{ kind: "person", principal, surface }` (the caller’s owner string and `surface`), and the run is tagged `origin:person`. An `input` that does not satisfy the workflow’s `inputSchema` is `InvalidParams` whose `data.issues` locates every failure, and nothing is created; a raw `weft.workflows.start` is not checked first. A workflow that is missing, invalid, or paused is `NotFound`. An earlier file change the engine has not followed is `Unavailable` (`workflow-apply-failed`). Requires `bureau.workflows:write` unless the caller owns the deployment’s workflows; anyone else is answered `NotFound`.',
  destructive: true,
  tags: ['Workflows'],
  inputSchema: startInput,
  outputSchema: startOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'Unavailable', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const workflows = workflowsFor(host, principal, 'bureau.workflows:write', 'workflow', input.id);
    try {
      return await workflows.start(input.id, {
        input: input.input,
        // v1 has one user: a caller with no owner string of its own starts it as the deployment's.
        owner: ownerOfPrincipal(principal) ?? DEPLOYMENT_OWNER,
        surface: input.surface,
      });
    } catch (error) {
      if (error instanceof WorkflowInputInvalidError) {
        throw {
          code: 'InvalidParams',
          message: error.message,
          data: {
            issues: error.issues.map((issue) => ({
              path: ['input', ...issue.path],
              message: issue.message,
              code: 'custom',
            })),
          },
        } satisfies OperationFault;
      }
      if (error instanceof WorkflowApplyError) return faultOf(error, input.id);
      if (error instanceof BureauError && error.code === 'NOT_FOUND') {
        throw resourceNotFound('workflow', input.id);
      }
      if (error instanceof BureauError && error.code === 'BAD_REQUEST') {
        throw {
          code: 'InvalidParams',
          message: error.message,
          data: { issues: [{ path: ['input'], message: error.message, code: 'custom' }] },
        } satisfies OperationFault;
      }
      throw error;
    }
  },
});

const internalGetOutput = z.object({
  id: z.string(),
  description: z.string().nullable(),
  version: z.string().nullable(),
  source: z.object({
    kind: z.literal('code'),
    text: z.string().describe('The workflow’s description and its registered contract, as JSON.'),
  }),
});

export const workflowsInternalGetOperation = defineOperation<
  typeof getInput,
  typeof internalGetOutput,
  BureauWorkflowsOperationHost
>({
  name: 'bureau.workflows.internal.get',
  mcpExposable: false,
  summary: 'Read a code-defined workflow',
  description:
    'Returns a workflow that code registered with the engine, rather than one a file defines: the Bureau’s agent run, goal, and heartbeat tick among them. `description` is the one sentence the code gives it (`null` when it gives none), and `source` is `{ kind: "code", text }` where `text` is that description followed by the workflow’s registered contract as JSON; the code itself is not exposed. A workflow that has a file is read with `bureau.workflows.get`, and an identifier the engine does not know as code is `NotFound`. Requires `bureau.workflows:read` unless the caller owns the deployment’s workflows; anyone else is answered `NotFound`.',
  destructive: false,
  tags: ['Workflows'],
  inputSchema: getInput,
  outputSchema: internalGetOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const workflows = workflowsFor(host, principal, 'bureau.workflows:read', 'workflow', input.id);
    const detail = workflows.getCode(input.id);
    if (detail === undefined) throw resourceNotFound('workflow', input.id);
    return { ...detail, source: { ...detail.source } };
  },
});

const signalInput = z.object({
  name: z
    .string()
    .min(1)
    .max(SIGNAL_NAME_MAXIMUM_LENGTH)
    .describe('The signal’s name: the `name` of a signal trigger and of an `await-signal` step.'),
  payload: z.json().optional().describe('What the signal carries; `null` when omitted.'),
  signalId: z
    .string()
    .min(1)
    .refine(
      (signalId) => new TextEncoder().encode(signalId).byteLength <= SIGNAL_ID_MAXIMUM_BYTES,
      `signalId must be at most ${String(SIGNAL_ID_MAXIMUM_BYTES)} bytes`,
    )
    .optional()
    .describe('Makes a retried delivery apply once; starts are never deduplicated.'),
});

const schemaIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});

const signalOutput = z.object({
  started: z.array(z.string()),
  delivered: z.array(z.string()),
  /**
   * The workflows whose signal trigger matched but whose `inputSchema` the payload does not
   * satisfy: nothing was started for them.
   */
  rejected: z.array(z.object({ id: z.string(), issues: z.array(schemaIssueSchema) })),
});

export const workflowsSignalOperation = defineOperation<
  typeof signalInput,
  typeof signalOutput,
  BureauWorkflowsOperationHost
>({
  name: 'bureau.workflows.signal',
  mcpExposable: false,
  summary: 'Signal workflows',
  description:
    'Delivers `payload` to every running workflow instance that waits at an `await-signal` step named `name`, then starts one instance of every ready, unpaused workflow whose trigger is `{ kind: "signal", name }`, with `{ kind: "signal", name, payload }` as its `trigger`. Returns the `delivered` instance identifiers and the `started` ones. A matching workflow whose `inputSchema` the payload does not satisfy starts nothing and is listed in `rejected` with the issues. Delivery happens first, so an instance this call starts is never satisfied by this call. A paused or deleted workflow starts nothing, and its running instances still receive the signal. `signalId` (at most 128 bytes) makes a retried delivery apply once; starts are not deduplicated. A payload the engine would refuse is `InvalidParams`, and nothing is delivered. An engine error during delivery, or an earlier file change the engine has not followed, is `Unavailable` (`data.reason` is `signal-delivery-failed` or `workflow-apply-failed`) and starts nothing; its message names the instances already reached. Requires `bureau.workflows:write` unless the caller owns the deployment’s workflows; anyone else gets `{ started: [], delivered: [], rejected: [] }`.',
  destructive: true,
  tags: ['Workflows'],
  inputSchema: signalInput,
  outputSchema: signalOutput,
  producibleFaults: ['InvalidParams', 'Unavailable', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    if (!mayAccessWorkflows(host, principal, 'bureau.workflows:write')) {
      return { started: [], delivered: [], rejected: [] };
    }
    const workflows = workflowsOf(host);
    try {
      const result = await workflows.signal(input.name, input.payload ?? null, {
        signalId: input.signalId,
      });
      return {
        started: result.started,
        delivered: result.delivered,
        rejected: result.rejected.map((entry) => ({
          id: entry.id,
          issues: entry.issues.map((issue) => ({ path: [...issue.path], message: issue.message })),
        })),
      };
    } catch (error) {
      if (error instanceof WorkflowSignalFailure) {
        // Weft's `Unavailable` carries only `reason` and `retryAfterSeconds` on the wire, so the
        // instances already reached are named in the message; `error.delivered` holds them for an
        // in-process caller.
        throw {
          code: 'Unavailable',
          message: error.message,
          data: { reason: error.code },
        } satisfies OperationFault;
      }
      if (error instanceof BureauError && error.code === 'BAD_REQUEST') {
        throw {
          code: 'InvalidParams',
          message: error.message,
          data: { issues: [{ path: ['payload'], message: error.message, code: 'custom' }] },
        } satisfies OperationFault;
      }
      throw error;
    }
  },
});

/** The workflow operations, in the order the handler serves them. */
export const bureauWorkflowsOperations = [
  workflowsCreateOperation,
  workflowsUpdateOperation,
  workflowsPauseOperation,
  workflowsResumeOperation,
  workflowsDeleteOperation,
  workflowsGetOperation,
  workflowsListOperation,
  workflowsRevisionsOperation,
  workflowsRunsListOperation,
  workflowsRunsGetOperation,
  workflowsStartOperation,
  workflowsInternalGetOperation,
  workflowsSignalOperation,
] as const;
