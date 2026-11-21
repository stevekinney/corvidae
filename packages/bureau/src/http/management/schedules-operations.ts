import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';

/**
 * `bureau.schedules.*`: the durable schedules of a Bureau (COR-1482), over the Bureau's own
 * schedule methods.
 *
 * A schedule belongs to the principal that created it. A caller reads and changes its own
 * schedules without any scope; `bureau.schedules:read` grants every owner's to `list`, `get`, and
 * `missed`, and `bureau.schedules:write` grants `pause`, `resume`, `cancel`, `update`, `skipnext`,
 * `unskip`, and `runnow`, and neither implies the other. A schedule the caller may not see, or change, is answered exactly as a
 * missing one. The schedule of a workflow file belongs to the deployment's owner of record and to
 * its file: it is read here like any schedule, and a write to it is refused as if it did not
 * exist, because `bureau.workflows.*` is the only way to change it. `create` makes a schedule the
 * caller owns, so it needs no scope; the owner comes from the caller's credential.
 *
 * A schedule runs one target (COR-2546): a catalog agent, or a workflow that
 * `bureau.workflows.start` could start (a code workflow a plugin contributed, or a workflow file),
 * which the caller needs the same authorization to name. A workflow schedule is owned by its
 * creator like an agent schedule, but its owner is kept in the Weft schedule's `metadata`, because
 * the workflow receives its input as the caller wrote it. The view's `target` says which kind a
 * schedule is.
 *
 * Every schedule carries a `revision` that Weft keeps: `1` when it is created, then one more for
 * each change to the schedule itself (an update, a pause, a resume, a cancel; the automatic pause
 * after a timer failure counts, a fire or a call that changes nothing does not). Each write takes
 * `expectedRevision`, which Weft compares inside its serialized write; a mismatch is a
 * `StaleRevision` fault carrying the revision now current, and nothing is written. Bureau never
 * compares it itself.
 *
 * What a schedule's views carry of its input, which is the prompt each fire runs: `inputPreview`,
 * its start, at most 500 characters and ending in `…` when cut, so a schedule can be told by what it
 * says (`null` for a workflow file's schedule and for an input of media alone). It is served to
 * its exact owner within a workspace; shared administrator views redact it and private fire counters. The
 * rest of the input, and its session, stay in storage. A view also names the agent each fire runs
 * (`agentName`, `null` for a workflow file's schedule, which runs none), because that names a
 * resource and carries no content.
 *
 * @module schedules-operations
 */

import {
  isValidTimeZone,
  ScheduleOccurrenceNotNextError,
  type ScheduleSummary,
  ScheduleStaleRevisionError,
} from '@lostgradient/weft';
import { defineOperation, type OperationFault, type Principal } from '@lostgradient/backchannel';
import { z } from 'zod';

import {
  BureauError,
  ScheduleLocatorUnavailableError,
  UnknownScheduleAgentError,
  UnknownScheduleWorkflowError,
} from '../../bureau-errors.ts';
import { bureauNameOf } from '../../namespaced-identifier.ts';
import { AGENT_SCHEDULE_WORKFLOW_TYPE } from '../../workflow-schedule.ts';
import { scheduleInputPreview } from '../../schedule-input-preview.ts';
import type { BureauSchedules, ScheduleActor } from '../../bureau-types/schedules.ts';
import { WorkflowInputInvalidError } from '../../workflow-schema.ts';
import type { BureauWorkflows, WorkflowScheduleBlocker } from '../../workflow-runtime.ts';
import type { BureauScope } from '../bureau-scopes.ts';
import { hostPanelUriOfCall } from '../host-panel-operations.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import type { BureauAgentVisibilityHost } from './deployment-operations.ts';
import { mayAccessWorkflows } from './workflows-operations.ts';
import {
  DEFAULT_PAGE_LIMIT,
  pageFields,
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';
import { dryRunField, dryRunResult, effect, orDryRun } from './dry-run.ts';

/** What the schedule operations read from the handler's `host`. */
export type BureauSchedulesOperationHost = BureauOwnershipHost &
  BureauAgentVisibilityHost & {
    /** The workflows a schedule may run, judged as `bureau.workflows.start` judges them. */
    readonly workflows: BureauWorkflows | undefined;
    readonly schedules: Pick<
      BureauSchedules,
      | 'create'
      | 'createWorkflow'
      | 'get'
      | 'list'
      | 'pause'
      | 'resume'
      | 'cancel'
      | 'update'
      | 'skipNext'
      | 'unskip'
      | 'runNow'
      | 'missed'
      | 'agentName'
      | 'inputPreview'
      | 'continuesChat'
      | 'blocker'
    > & {
      /** The owner of record of a schedule, or `undefined` when it is not a Bureau schedule. */
      readonly owner: (scheduleId: string) => Promise<string | undefined>;
      /** Whether the Bureau's agent catalog holds an agent named `name`. */
      readonly hasAgent: (name: string) => boolean;
    };
  };

const scheduleStatus = z.enum(['active', 'paused', 'cancelled']);
const scheduleIdentifier = z.string().min(1).max(256).describe('The identifier of the schedule.');
const expectedRevision = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(
    'The schedule’s `revision` the caller read; when it has changed since, the call is a `StaleRevision` fault and nothing is written.',
  );

const scheduleViewSchema = z.object({
  id: z.string(),
  owner: z.string(),
  /** The catalog agent each fire runs; `null` for a schedule that runs none, a workflow file's. */
  agentName: z.string().nullable(),
  /**
   * What each fire runs (COR-2546): `{ kind: 'agent', agentName }` for a catalog agent, or
   * `{ kind: 'workflow', workflowType }` for a workflow, named as `bureau.workflows.*` names it (the
   * `plugin:name` of a code workflow, the identifier of a workflow file), which is not always the
   * engine's `workflowType` below.
   */
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('agent'), agentName: z.string() }),
    z.object({ kind: z.literal('workflow'), workflowType: z.string() }),
  ]),
  /** The start of the text each fire sends, at most 500 characters; `null` when the schedule sends none. */
  inputPreview: z.string().nullable(),
  /** Whether every fire continues one chat; `false` when each fire is a fresh one, and for a workflow file's schedule. The chat's own id is never served. */
  continuesChat: z.boolean(),
  workflowType: z.string(),
  description: z.string().nullable(),
  /** Set for a cron schedule, `null` for an interval one. */
  cronExpression: z.string().nullable(),
  /** Set for an interval schedule, `null` for a cron one. */
  intervalMs: z.number().nullable(),
  /** The IANA time zone a cron schedule is read in; `UTC` for an interval one and for a schedule created without one. */
  timeZone: z.string(),
  status: scheduleStatus,
  overlap: z.enum(['skip', 'queue', 'cancel-running', 'allow']),
  revision: z.number().int(),
  nextFireAt: z.string().nullable(),
  /**
   * The upcoming fires a person asked to skip (`bureau.schedules.skipnext`), as ISO 8601 instants,
   * soonest first; empty when none is. Each is a fire that would start a run, which the next is not
   * always at `nextFireAt`: in a time zone `nextFireAt` can be the end of a daylight-saving gap that
   * starts nothing. `bureau.schedules.unskip` takes one back.
   */
  skippedOccurrences: z.array(z.string()),
  lastFireAt: z.string().nullable(),
  missedFireCount: z.number().int().nullable(),
  skippedCount: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * Why the schedule won't start (COR-2009), or `null` when nothing blocks it: a workflow file's
   * schedule whose file stopped parsing is kept from the file's last good version and starts nothing
   * until the file parses again. `status` then reads as the schedule holds it (`active` when it was
   * active), and `nextFireAt` is the fire it won't start.
   */
  blocker: z
    .object({
      kind: z.literal('workflow-cannot-load'),
      /** The workflow whose file can't load. */
      workflow: z.string(),
      /** What is wrong with the file. */
      message: z.string(),
    })
    .nullable(),
});

const receiptSchema = z.object({
  id: z.string(),
  status: scheduleStatus,
  /** The schedule's revision after the change, to pass as the next `expectedRevision`. */
  revision: z.number().int(),
});

function iso(milliseconds: number | null | undefined): string | null {
  return milliseconds === null || milliseconds === undefined
    ? null
    : new Date(milliseconds).toISOString();
}

function viewOf(
  summary: ScheduleSummary,
  owner: string,
  agentName: string | undefined,
  inputPreview: string | undefined,
  continuesChat: boolean | undefined,
  blocker: WorkflowScheduleBlocker | undefined,
  principal: Principal,
): z.infer<typeof scheduleViewSchema> {
  const redactPrivateProjection =
    principal.method !== 'unauthenticated' &&
    principal.workspace !== undefined &&
    ownerOfPrincipal(principal) !== owner;
  return {
    id: summary.id,
    owner,
    agentName: agentName ?? null,
    target:
      agentName === undefined
        ? { kind: 'workflow', workflowType: bureauNameOf(summary.workflowType) }
        : { kind: 'agent', agentName },
    inputPreview: redactPrivateProjection ? null : (inputPreview ?? null),
    continuesChat: redactPrivateProjection ? false : (continuesChat ?? false),
    workflowType: summary.workflowType,
    description: summary.description ?? null,
    cronExpression: summary.cronExpression ?? null,
    intervalMs: summary.intervalMs ?? null,
    timeZone: summary.timeZone,
    status: blocker?.status ?? summary.status,
    overlap: summary.overlap,
    revision: summary.revision,
    nextFireAt: iso(summary.nextFireAt),
    skippedOccurrences: (summary.skippedOccurrences ?? []).map((at) => iso(at)!),
    lastFireAt: redactPrivateProjection ? null : iso(summary.lastFireAt),
    missedFireCount: redactPrivateProjection ? null : summary.missedFireCount,
    skippedCount: redactPrivateProjection ? null : summary.skippedCount,
    createdAt: iso(summary.createdAt)!,
    updatedAt: iso(summary.updatedAt)!,
    blocker:
      blocker === undefined
        ? null
        : { kind: blocker.kind, workflow: blocker.workflow, message: blocker.message },
  };
}

const timeZoneField = z
  .string()
  .min(1)
  .max(100)
  .describe(
    'The IANA time zone a cron `spec` is read in, such as `America/Los_Angeles`, or `UTC`. Without one a schedule runs in UTC. A time the clock skips when it springs forward is counted as a missed fire (reason `dst-gap`), and a time it repeats when it falls back runs once. An interval `spec` takes none.',
  );

/** `InvalidParams` on `timeZone` for a zone the runtime does not know, before anything is written. */
function assertKnownTimeZone(timeZone: string | undefined): void {
  if (timeZone !== undefined && !isValidTimeZone(timeZone)) {
    throw invalidParams(
      'timeZone',
      `\`timeZone\` must be an IANA time zone name such as "America/Los_Angeles", or "UTC"; "${String(timeZone)}" is not one`,
    );
  }
}

function unsupported(): OperationFault {
  return {
    code: 'UnsupportedCapability',
    message: 'This Bureau has no durable engine, so it has no schedules',
    data: { capability: 'durable-schedules' },
  };
}

function invalidParams(path: string, message: string): OperationFault {
  return {
    code: 'InvalidParams',
    message,
    data: { issues: [{ path: [path], message, code: 'custom' }] },
  };
}

/**
 * The fault a failed schedule call is answered with, or the error itself when it is none this
 * module knows. Weft words a schedule that is not there, and a cadence it cannot parse, in the
 * message of a plain `Error`, so those are read from it.
 */
function faultOf(error: unknown, scheduleId: string): never {
  // The schedule was created and only its summary could not be read, so the id is the caller's
  // to keep: a retry of `create` would make a second schedule. Weft's `Unavailable` carries only
  // a reason on the wire, so the id is in the message, and `bureau.schedules.get` reads it back.
  if (error instanceof ScheduleLocatorUnavailableError) {
    throw {
      code: 'Unavailable',
      message: `Schedule "${error.scheduleId}" was created, but its summary could not be read. Do not create it again: read it with bureau.schedules.get.`,
      data: { reason: 'schedule-created-summary-unavailable' },
    } satisfies OperationFault;
  }
  if (error instanceof ScheduleStaleRevisionError) {
    throw {
      code: 'StaleRevision',
      message: error.message,
      data: {
        expectedRevision: error.expectedRevision,
        currentRevision: error.currentRevision,
      },
    } satisfies OperationFault;
  }
  // A fire moves neither the revision nor the status, so the run a skip named can have started
  // since it was read (COR-1985). The reason tells this refusal from a paused or cancelled schedule.
  if (error instanceof ScheduleOccurrenceNotNextError) {
    throw {
      code: 'Conflict',
      message: error.message,
      data: { reason: 'occurrence-not-next' },
    } satisfies OperationFault;
  }
  if (error instanceof UnknownScheduleAgentError) throw resourceNotFound('agent', error.agentName);
  if (error instanceof UnknownScheduleWorkflowError) {
    throw resourceNotFound('workflow', error.workflowType);
  }
  // The input a workflow schedule is given breaks the workflow's schema, as a start's would.
  if (error instanceof WorkflowInputInvalidError) {
    throw {
      code: 'InvalidParams',
      message: error.message,
      data: {
        issues: error.issues.map((issue) => ({
          path: ['workflowInput', ...issue.path],
          message: issue.message,
          code: 'custom',
        })),
      },
    } satisfies OperationFault;
  }
  if (error instanceof BureauError) {
    if (error.code === 'NOT_FOUND') throw resourceNotFound('schedule', scheduleId);
    if (error.code === 'BAD_REQUEST') throw invalidParams('schedule', error.message);
    if (error.code === 'NOT_CONFIGURED') {
      throw {
        code: 'UnsupportedCapability',
        message: error.message,
        data: { capability: 'generate' },
      } satisfies OperationFault;
    }
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('not found')) throw resourceNotFound('schedule', scheduleId);
    if (message.includes('cannot be resumed') || message.includes('cannot be run')) {
      throw {
        code: 'Conflict',
        message: error.message,
        data: { reason: 'schedule-cancelled' },
      } satisfies OperationFault;
    }
    if (message.includes('has no next occurrence to skip')) {
      throw {
        code: 'Conflict',
        message: error.message,
        data: { reason: 'schedule-not-active' },
      } satisfies OperationFault;
    }
    if (message.includes('occurrences, the most it keeps')) {
      throw {
        code: 'Conflict',
        message: error.message,
        data: { reason: 'too-many-skips' },
      } satisfies OperationFault;
    }
    // Weft words a zone it refuses with the option's name, and that message also says `must be` or
    // `interval`, so the zone is told apart first.
    if (message.includes('options.timezone')) {
      throw invalidParams('timeZone', error.message);
    }
    if (message.includes('cron') || message.includes('interval') || message.includes('must be')) {
      throw invalidParams('spec', error.message);
    }
  }
  throw error;
}

/**
 * Who asks, for the audit trail (COR-2545): the caller's owner of record, and the host panel the
 * call came through, which is read from the call's own in-process scope and never from the request.
 */
function actorOf(principal: Principal): ScheduleActor | undefined {
  const owner = ownerOfPrincipal(principal);
  if (owner === undefined) return undefined;
  const panelUri = hostPanelUriOfCall();
  return panelUri === undefined ? { principal: owner } : { principal: owner, panelUri };
}

/**
 * The owner of schedule `scheduleId` when `principal` may use `operatorScope` on it, and
 * `NotFound` otherwise: for a caller who may not, a schedule that is not there, and one that is
 * not a Bureau schedule, are the same answer.
 */
function isWorkspaceAdministrator(principal: Principal): boolean {
  return (
    principal.method !== 'unauthenticated' &&
    principal.workspace?.capabilities.includes('workspace:manage') === true
  );
}

async function ownerFor(
  host: BureauSchedulesOperationHost,
  principal: Principal,
  scheduleId: string,
  operatorScope: BureauScope,
  privateExecution = false,
): Promise<string> {
  const owner = await host.schedules.owner(scheduleId);
  if (
    owner === undefined ||
    (!(!privateExecution && isWorkspaceAdministrator(principal)) &&
      !host.ownership.mayAccess({ principal, resourceOwner: owner, operatorScope }))
  ) {
    throw resourceNotFound('schedule', scheduleId);
  }
  return owner;
}

async function receiptOf(
  host: BureauSchedulesOperationHost,
  scheduleId: string,
): Promise<z.infer<typeof receiptSchema>> {
  const summary = await host.schedules.get(scheduleId);
  if (summary === null || summary === undefined) throw resourceNotFound('schedule', scheduleId);
  return { id: summary.id, status: summary.status, revision: summary.revision };
}

const listInput = z.object({
  status: scheduleStatus.optional().describe('Only the schedules in this status.'),
  ...pageFields,
});
const listOutput = z.object({
  schedules: z.array(scheduleViewSchema),
  nextOffset: z.number().int().nullable(),
});

/** How many schedules one read of the engine's list asks for. */
const SCAN_PAGE_SIZE = 100;

export const schedulesListOperation = defineOperation<
  typeof listInput,
  typeof listOutput,
  BureauSchedulesOperationHost
>({
  name: 'bureau.schedules.list',
  authorize: authorizeWorkspaceOperation('bureau.schedules.list'),
  mcpExposable: true,
  summary: 'List schedules',
  description:
    'Lists the caller’s own schedules, oldest first; a caller holding `bureau.schedules:read` lists every owner’s, including the native schedule of a workflow file, which belongs to the deployment’s owner. `status` narrows to one status. Pages with `limit` (1 to 100, default 50) and `offset`; `nextOffset` is `null` on the last page. A view carries the schedule’s `revision` and `inputPreview`, the start of the text each fire sends (at most 500 characters).',
  destructive: false,
  tags: ['Schedules'],
  inputSchema: listInput,
  outputSchema: listOutput,
  producibleFaults: ['InvalidParams', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const everyOwner =
      isWorkspaceAdministrator(principal) ||
      (principal.method !== 'unauthenticated' &&
        principal.workspace === undefined &&
        principal.hasScope('bureau.schedules:read'));
    const caller = ownerOfPrincipal(principal);
    if (!everyOwner && caller === undefined) return { schedules: [], nextOffset: null };
    const visible: z.infer<typeof scheduleViewSchema>[] = [];
    for (let offset = 0; ; offset += SCAN_PAGE_SIZE) {
      // Every status is read and the filter applied to the view: a schedule held for its file reads
      // as `active` although the engine holds it paused (COR-2009).
      const page = await host.schedules.list({ limit: SCAN_PAGE_SIZE, offset });
      if (page === undefined) throw unsupported();
      for (const summary of page.items) {
        const owner = await host.schedules.owner(summary.id);
        if (owner !== undefined && (everyOwner || owner === caller)) {
          const view = viewOf(
            summary,
            owner,
            await host.schedules.agentName(summary.id),
            await host.schedules.inputPreview(summary.id),
            await host.schedules.continuesChat(summary.id),
            await host.schedules.blocker(summary.id),
            principal,
          );
          if (input.status === undefined || view.status === input.status) visible.push(view);
        }
      }
      if (offset + page.items.length >= page.total || page.items.length === 0) break;
    }
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const start = input.offset ?? 0;
    return {
      schedules: visible.slice(start, start + limit),
      nextOffset: visible.length > start + limit ? start + limit : null,
    };
  },
});

const getInput = z.object({ scheduleId: scheduleIdentifier });

export const schedulesGetOperation = defineOperation<
  typeof getInput,
  typeof scheduleViewSchema,
  BureauSchedulesOperationHost
>({
  name: 'bureau.schedules.get',
  authorize: authorizeWorkspaceOperation('bureau.schedules.get'),
  mcpExposable: true,
  summary: 'Read one schedule',
  description:
    'Returns one of the caller’s own schedules; a caller holding `bureau.schedules:read` reads any owner’s. Another owner’s schedule answers as a missing one does. The view carries the schedule’s `revision`, to pass back as `expectedRevision`, and `inputPreview`, the start of the text each fire sends (at most 500 characters).',
  destructive: false,
  tags: ['Schedules'],
  inputSchema: getInput,
  outputSchema: scheduleViewSchema,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const owner = await ownerFor(host, principal, input.scheduleId, 'bureau.schedules:read');
    const summary = await host.schedules.get(input.scheduleId);
    if (summary === null || summary === undefined) {
      throw resourceNotFound('schedule', input.scheduleId);
    }
    return viewOf(
      summary,
      owner,
      await host.schedules.agentName(input.scheduleId),
      await host.schedules.inputPreview(input.scheduleId),
      await host.schedules.continuesChat(input.scheduleId),
      await host.schedules.blocker(input.scheduleId),
      principal,
    );
  },
});

/** Which workflow-only and agent-only fields a call names, for the one-target check of `create` and `update`. */
function refuseMixedTarget(
  input: {
    readonly agentName?: string | undefined;
    readonly workflowType?: string | undefined;
    readonly workflowInput?: unknown;
    readonly input?: string | undefined;
    readonly sessionId?: string | null | undefined;
    readonly continueChat?: boolean | undefined;
  },
  agentOnly: readonly string[],
): void {
  if (input.agentName !== undefined && input.workflowType !== undefined) {
    throw invalidParams('workflowType', 'Name one target: `agentName` or `workflowType`, not both');
  }
  if (input.workflowType !== undefined || input.workflowInput !== undefined) {
    const named = agentOnly.filter((field) => Reflect.get(input, field) !== undefined);
    if (named.length > 0) {
      throw invalidParams(
        named[0]!,
        `\`${named.map(String).join('`, `')}\` apply only to an agent; a workflow takes \`workflowInput\``,
      );
    }
  }
}

/**
 * The workflows a caller may start schedules of: the authorization `bureau.workflows.start` applies,
 * and a workflow the caller could not start is as unknown to it as one that is not there.
 */
function workflowsForSchedule(
  host: BureauSchedulesOperationHost,
  principal: Principal,
  workflowType: string,
): void {
  const workspaceMember =
    principal.method !== 'unauthenticated' && principal.workspace !== undefined;
  if (
    !mayAccessWorkflows(
      host,
      principal,
      workspaceMember ? 'bureau.workflows:read' : 'bureau.workflows:write',
    )
  ) {
    throw resourceNotFound('workflow', workflowType);
  }
  if (host.workflows === undefined) {
    throw {
      code: 'UnsupportedCapability',
      message: 'This Bureau has no workflow directory, so it has no workflows',
      data: { capability: 'workflow-directory' },
    } satisfies OperationFault;
  }
  if (workspaceMember) {
    throw {
      code: 'Conflict',
      message: 'A workspace Bureau does not schedule workflows',
      data: { reason: 'workflow-schedules-unavailable-in-workspace' },
    } satisfies OperationFault;
  }
}

const createInput = z.object({
  agentName: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      'The catalog agent each fire runs. Name exactly one target: `agentName` or `workflowType`.',
    ),
  workflowType: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      'The workflow each fire starts: a `plugin:name` code workflow, or a ready, unpaused workflow file, named as `bureau.workflows.start` names it. A code workflow receives `workflowInput` as its input, and a workflow file the trigger envelope `{ kind: "schedule", scheduleId, input }` with `workflowInput` as its `input`. Name exactly one target: `agentName` or `workflowType`.',
    ),
  workflowInput: z
    .json()
    .optional()
    .describe(
      'The JSON input each fire starts the workflow with, which its `inputSchema` must accept; `null` when omitted. Only with `workflowType`.',
    ),
  spec: z
    .string()
    .min(1)
    .max(256)
    .describe('A cron expression, or a duration such as `30s`, `6h`, or `1d`.'),
  input: z
    .string()
    .min(1)
    .max(100_000)
    .optional()
    .describe('The text delivered to the agent each fire. Required with `agentName`.'),
  description: z.string().max(2_000).optional().describe('A description of the schedule.'),
  sessionId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('A session each fire continues; without one, every fire is a fresh session.'),
  continueChat: z
    .boolean()
    .optional()
    .describe(
      'Start a new chat that every fire continues, which the Bureau names itself and the first fire makes, owned by the caller. Refused together with `sessionId`.',
    ),
  overlap: z
    .enum(['skip', 'allow'])
    .optional()
    .describe(
      'Whether a fire starts while the previous one is still running: `skip` does not, `allow` does (refused with a `sessionId`). Defaults to `skip`.',
    ),
  timeZone: timeZoneField.optional(),
});

export const schedulesCreateOperation = defineOperation<
  typeof createInput,
  typeof scheduleViewSchema,
  BureauSchedulesOperationHost
>({
  name: 'bureau.schedules.create',
  authorize: authorizeWorkspaceOperation('bureau.schedules.create'),
  mcpExposable: false,
  summary: 'Create a schedule',
  description:
    'Creates a schedule that runs one target on `spec`, a cron expression or a duration: the catalog agent `agentName` with the text `input` (required with it), or the workflow `workflowType` with the JSON `workflowInput`. Naming both targets, or neither, is `InvalidParams`, as are `input`, `sessionId`, and `continueChat` with a workflow and `workflowInput` with an agent. A workflow is a `plugin:name` code workflow, which receives `workflowInput` as its input, or a ready, unpaused workflow file, which receives the trigger envelope `{ kind: "schedule", scheduleId, input }` with `workflowInput` as its `input`, as its own schedule’s fires do; the caller must be able to start it with `bureau.workflows.start`, and a workflow that is not there, or that the caller could not start, is `NotFound`, while an input its schema refuses is `InvalidParams`. A workspace Bureau does not schedule workflows (`Conflict`). The caller owns the schedule, so no scope is needed; the owner is kept in the schedule’s metadata, never in what the workflow receives; every fire of an agent is a task the owner can list, read, observe, and cancel. `sessionId` makes each fire continue one session, and `continueChat: true` starts a new chat for it that the Bureau names itself (`overlap: "allow"` is refused with either), and `overlap` defaults to `skip`. An agent that is not in the catalog is `NotFound`; a `spec` that is not a cadence, a `timeZone` that is not an IANA zone (or is given with an interval, where only `UTC` is accepted), or a combination Bureau refuses, is `InvalidParams`. Answers the schedule’s view, whose `revision` is `1`.',
  destructive: true,
  tags: ['Schedules'],
  inputSchema: createInput,
  outputSchema: scheduleViewSchema,
  producibleFaults: [
    'InvalidParams',
    'Forbidden',
    'NotFound',
    'Conflict',
    'Unavailable',
    'UnsupportedCapability',
  ],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const owner = ownerOfPrincipal(principal);
    if (owner === undefined) {
      throw {
        code: 'Forbidden',
        message: 'A schedule needs an owner, and this credential names none',
        data: { reason: 'no owner of record' },
      } satisfies OperationFault;
    }
    refuseMixedTarget(input, ['input', 'sessionId', 'continueChat']);
    // The entry of `schedule.created` names who asked, and the host panel they asked through.
    const createdBy = { actor: actorOf(principal) };
    if (input.workflowType !== undefined) {
      workflowsForSchedule(host, principal, input.workflowType);
      assertKnownTimeZone(input.timeZone);
      try {
        const summary = await host.schedules.createWorkflow(
          {
            workflowType: input.workflowType,
            spec: input.spec,
            ...(input.workflowInput === undefined ? {} : { workflowInput: input.workflowInput }),
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.overlap === undefined ? {} : { overlap: input.overlap }),
            ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
            principal: owner,
          },
          createdBy,
        );
        if (summary === undefined) throw unsupported();
        return viewOf(summary, owner, undefined, undefined, false, undefined, principal);
      } catch (error) {
        return faultOf(error, input.workflowType);
      }
    }
    if (input.agentName === undefined) {
      throw invalidParams('agentName', 'Name one target: `agentName` or `workflowType`');
    }
    if (input.input === undefined) {
      throw invalidParams(
        'input',
        '`input`, the text each fire sends, is required with `agentName`',
      );
    }
    if (input.workflowInput !== undefined) {
      throw invalidParams('workflowInput', '`workflowInput` applies only with `workflowType`');
    }
    // An agent the caller may not name (COR-1904) is as unknown to it as one the catalog lacks.
    if (
      !host.agentVisibility.mayName(principal, input.agentName) ||
      !host.schedules.hasAgent(input.agentName)
    ) {
      throw resourceNotFound('agent', input.agentName);
    }
    assertKnownTimeZone(input.timeZone);
    try {
      const summary = await host.schedules.create(
        {
          agentName: input.agentName,
          spec: input.spec,
          input: input.input,
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
          ...(input.continueChat === true ? { continueChat: true } : {}),
          ...(input.overlap === undefined ? {} : { overlap: input.overlap }),
          ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
          principal: owner,
        },
        createdBy,
      );
      if (summary === undefined) throw unsupported();
      // The preview comes from the request's own text, never a second read of storage: a read that
      // failed after the schedule was made would hide the schedule from a retry (COR-411).
      return viewOf(
        summary,
        owner,
        input.agentName,
        scheduleInputPreview(input.input),
        input.sessionId !== undefined || input.continueChat === true,
        undefined,
        principal,
      );
    } catch (error) {
      return faultOf(error, input.agentName);
    }
  },
});

const guardedInput = z.object({ scheduleId: scheduleIdentifier, expectedRevision });

function defineGuardedWrite(
  name: 'bureau.schedules.pause' | 'bureau.schedules.resume',
  summary: string,
  description: string,
  run: (
    schedules: BureauSchedulesOperationHost['schedules'],
    scheduleId: string,
    guard: {
      readonly expectedRevision: number | undefined;
      readonly actor: ScheduleActor | undefined;
    },
  ) => Promise<true | undefined>,
) {
  return defineOperation<typeof guardedInput, typeof receiptSchema, BureauSchedulesOperationHost>({
    name,
    authorize: authorizeWorkspaceOperation(name),
    mcpExposable: false,
    summary,
    description,
    destructive: true,
    tags: ['Schedules'],
    inputSchema: guardedInput,
    outputSchema: receiptSchema,
    producibleFaults: [
      'InvalidParams',
      'NotFound',
      'Conflict',
      'StaleRevision',
      'UnsupportedCapability',
    ],
    access: { kind: 'authenticated' },
    discoverable: true,
    transports,
    unknownKeyPolicy,
    invoke: async ({ input, host, principal }) => {
      await ownerFor(host, principal, input.scheduleId, 'bureau.schedules:write');
      try {
        const done = await run(host.schedules, input.scheduleId, {
          expectedRevision: input.expectedRevision,
          actor: actorOf(principal),
        });
        if (done === undefined) throw unsupported();
      } catch (error) {
        return faultOf(error, input.scheduleId);
      }
      // The write scope does not imply the read scope: the receipt names the status and the
      // revision the caller needs to go on, and nothing else of the schedule.
      return receiptOf(host, input.scheduleId);
    },
  });
}

const STALE_NOTE =
  '`expectedRevision`, when given, is compared inside Weft’s serialized write: a schedule that has changed since is a `StaleRevision` fault whose `currentRevision` is the revision now current, and nothing is written. The receipt carries the revision after the change. Requires `bureau.schedules:write` unless the caller owns the schedule; anyone else is answered `NotFound`, as is the schedule of a workflow file, which only `bureau.workflows.*` changes.';

export const schedulesPauseOperation = defineGuardedWrite(
  'bureau.schedules.pause',
  'Pause a schedule',
  `Pauses an active schedule: it starts no new fire until it is resumed, and fires already running finish. Pausing a paused schedule changes nothing. ${STALE_NOTE}`,
  (schedules, id, guard) => schedules.pause(id, guard),
);

export const schedulesResumeOperation = defineGuardedWrite(
  'bureau.schedules.resume',
  'Resume a schedule',
  `Resumes a paused schedule. Resuming an active schedule changes nothing, and a cancelled schedule is a \`Conflict\`. ${STALE_NOTE}`,
  (schedules, id, guard) => schedules.resume(id, guard),
);

const cancelInput = guardedInput.extend({ dryRun: dryRunField });
const cancelAnswer = orDryRun(receiptSchema);

export const schedulesCancelOperation = defineOperation<
  typeof cancelInput,
  typeof cancelAnswer,
  BureauSchedulesOperationHost
>({
  name: 'bureau.schedules.cancel',
  authorize: authorizeWorkspaceOperation('bureau.schedules.cancel'),
  mcpExposable: false,
  supportsDryRun: true,
  summary: 'Cancel a schedule',
  description: `Cancels a schedule for good: its record stays, as \`cancelled\`, and it starts no new fire. Cancelling a cancelled schedule changes nothing. With \`dryRun: true\` nothing is cancelled: the answer is \`{ dryRun: true, target, effects }\`, whose \`queued-runs\` effect counts the occurrences waiting behind the fire in flight, which the cancel drops (the fire in flight finishes), and a schedule that is missing, not the caller’s or at another \`revision\` than \`expectedRevision\` answers the fault the real call answers. ${STALE_NOTE}`,
  destructive: true,
  tags: ['Schedules'],
  inputSchema: cancelInput,
  outputSchema: cancelAnswer,
  producibleFaults: [
    'InvalidParams',
    'NotFound',
    'Conflict',
    'StaleRevision',
    'UnsupportedCapability',
  ],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    await ownerFor(host, principal, input.scheduleId, 'bureau.schedules:write');
    if (input.dryRun === true) {
      try {
        // The checks of the cancel (a workflow file's schedule, a missing one, a stale revision),
        // made by the same method with nothing written.
        const checked = await host.schedules.cancel(input.scheduleId, {
          expectedRevision: input.expectedRevision,
          dryRun: true,
        });
        if (checked === undefined) throw unsupported();
      } catch (error) {
        return faultOf(error, input.scheduleId);
      }
      const summary = await host.schedules.get(input.scheduleId);
      if (summary === null || summary === undefined) {
        throw resourceNotFound('schedule', input.scheduleId);
      }
      return dryRunResult({ kind: 'schedule', id: input.scheduleId }, [
        effect('queued-runs', summary.queuedRuns.length),
      ]);
    }
    try {
      const done = await host.schedules.cancel(input.scheduleId, {
        expectedRevision: input.expectedRevision,
      });
      if (done === undefined) throw unsupported();
    } catch (error) {
      return faultOf(error, input.scheduleId);
    }
    // The write scope does not imply the read scope: the receipt names the status and the
    // revision the caller needs to go on, and nothing else of the schedule.
    return receiptOf(host, input.scheduleId);
  },
});

/** An ISO 8601 `occurrence` as milliseconds since the epoch, or `InvalidParams` before 1970. */
function occurrenceOf(occurrence: string): number {
  const at = Date.parse(occurrence);
  if (!Number.isSafeInteger(at) || at < 0) {
    throw invalidParams(
      'occurrence',
      '`occurrence` must be an ISO 8601 instant on or after 1970-01-01T00:00:00Z',
    );
  }
  return at;
}

const skipNextInput = guardedInput.extend({
  occurrence: z.iso
    .datetime({ offset: true })
    .optional()
    .describe(
      'The fire the caller means to skip, as an ISO 8601 instant: the view’s `nextFireAt` the caller read, or any upcoming fire after it. When it is not an upcoming fire that starts a task (a fire passed it, or the cadence starts none then), the call is a `Conflict` with `data.reason` `occurrence-not-next` and nothing is written. Left out, whichever fire is next is skipped.',
    ),
});

export const schedulesSkipNextOperation = defineOperation<
  typeof skipNextInput,
  typeof receiptSchema,
  BureauSchedulesOperationHost
>({
  name: 'bureau.schedules.skipnext',
  authorize: authorizeWorkspaceOperation('bureau.schedules.skipnext'),
  mcpExposable: false,
  summary: 'Skip an upcoming fire of a schedule',
  description: `Skips one upcoming fire of a schedule: \`occurrence\`, the next fire or any after it, starts no task, and the fires around it run as usual; left out, the next fire is skipped. Skipped fires are the view’s \`skippedOccurrences\` until the schedule moves past them, and \`bureau.schedules.unskip\` takes one back. The next fire is not always \`nextFireAt\`, which in a time zone can be the end of a daylight-saving gap that starts nothing. The skip leaves the schedule’s \`revision\` as it is, and skipping a fire already skipped changes nothing. A paused schedule’s fires can be skipped, counted from the first after now, and the pause keeps the skips for when it resumes; a cancel ends them, and a new cadence ends those that are no longer its fires. A fire moves neither the \`revision\` nor the \`status\`, so the fire a caller read can start before the skip is written: the skip is a \`Conflict\` (\`data.reason\` \`occurrence-not-next\`) when \`occurrence\` is not an upcoming fire as the write lands. An \`occurrence\` that is not an ISO 8601 instant, or is before 1970, is \`InvalidParams\`. A cancelled schedule has no fire to skip and is a \`Conflict\` (\`data.reason\` \`schedule-not-active\`), and so is a schedule that already skips 100 fires (\`data.reason\` \`too-many-skips\`). ${STALE_NOTE}`,
  destructive: true,
  tags: ['Schedules'],
  inputSchema: skipNextInput,
  outputSchema: receiptSchema,
  producibleFaults: [
    'InvalidParams',
    'NotFound',
    'Conflict',
    'StaleRevision',
    'UnsupportedCapability',
  ],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    await ownerFor(host, principal, input.scheduleId, 'bureau.schedules:write');
    const occurrence = input.occurrence === undefined ? undefined : occurrenceOf(input.occurrence);
    try {
      const done = await host.schedules.skipNext(
        input.scheduleId,
        { expectedRevision: input.expectedRevision },
        occurrence,
      );
      if (done === undefined) throw unsupported();
    } catch (error) {
      return faultOf(error, input.scheduleId);
    }
    return receiptOf(host, input.scheduleId);
  },
});

const unskipInput = guardedInput.extend({
  occurrence: z.iso
    .datetime({ offset: true })
    .describe(
      'The skipped fire to run after all, as an ISO 8601 instant: one of the view’s `skippedOccurrences`.',
    ),
});

export const schedulesUnskipOperation = defineOperation<
  typeof unskipInput,
  typeof receiptSchema,
  BureauSchedulesOperationHost
>({
  name: 'bureau.schedules.unskip',
  authorize: authorizeWorkspaceOperation('bureau.schedules.unskip'),
  mcpExposable: false,
  summary: 'Take back the skip of an upcoming fire of a schedule',
  description: `Takes back the skip of one upcoming fire of a schedule: \`occurrence\`, one of the view’s \`skippedOccurrences\`, starts a task after all. Like a skip it leaves the schedule’s \`revision\` as it is, and an upcoming fire that is not skipped changes nothing. A fire that has already passed cannot be taken back and is a \`Conflict\` (\`data.reason\` \`occurrence-not-next\`), and a cancelled schedule is a \`Conflict\` (\`data.reason\` \`schedule-not-active\`). An \`occurrence\` that is not an ISO 8601 instant, or is before 1970, is \`InvalidParams\`. ${STALE_NOTE}`,
  destructive: true,
  tags: ['Schedules'],
  inputSchema: unskipInput,
  outputSchema: receiptSchema,
  producibleFaults: [
    'InvalidParams',
    'NotFound',
    'Conflict',
    'StaleRevision',
    'UnsupportedCapability',
  ],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    await ownerFor(host, principal, input.scheduleId, 'bureau.schedules:write');
    const occurrence = occurrenceOf(input.occurrence);
    try {
      const done = await host.schedules.unskip(input.scheduleId, occurrence, {
        expectedRevision: input.expectedRevision,
      });
      if (done === undefined) throw unsupported();
    } catch (error) {
      return faultOf(error, input.scheduleId);
    }
    return receiptOf(host, input.scheduleId);
  },
});

const runNowInput = z.object({ scheduleId: scheduleIdentifier });
const runNowOutput = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('started'),
    taskId: z.string().describe('The task the run started as; `bureau.tasks.get` reads it.'),
  }),
  z.object({
    outcome: z.literal('queued'),
    taskId: z.string().describe('The task the run will start as, once the running one ends.'),
  }),
  z.object({
    outcome: z.literal('skipped'),
    blockingTaskId: z
      .string()
      .nullable()
      .describe('The task that was still running and kept this run from starting.'),
  }),
]);

export const schedulesRunNowOperation = defineOperation<
  typeof runNowInput,
  typeof runNowOutput,
  BureauSchedulesOperationHost
>({
  name: 'bureau.schedules.runnow',
  authorize: authorizeWorkspaceOperation('bureau.schedules.runnow'),
  mcpExposable: false,
  summary: 'Run a schedule now',
  description:
    'Starts one run of a schedule now, under its overlap policy, and answers what the policy did: `started` (with the task it started as), `queued` behind the running one, or `skipped` because a run was still going and the policy is `skip`. The task’s origin is `schedule` with `manual: true`, and it belongs to the schedule’s owner, and so does the run of a schedule a caller made for a workflow (the owner is read from the schedule’s metadata, never the deployment’s); a workflow that can no longer be started (its file was deleted or paused) makes the schedule `NotFound` and starts nothing. The run is not a fire of the cadence: the schedule’s `nextFireAt`, `lastFireAt`, and `revision` do not change. A paused schedule can be run; a cancelled one is a `Conflict`. Requires `bureau.schedules:write` unless the caller owns the schedule; anyone else is answered `NotFound`, as is the schedule of a workflow file, which only `bureau.workflows.*` changes.',
  destructive: true,
  tags: ['Schedules'],
  inputSchema: runNowInput,
  outputSchema: runNowOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'Conflict', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    await ownerFor(host, principal, input.scheduleId, 'bureau.schedules:write', true);
    try {
      const result = await host.schedules.runNow(input.scheduleId);
      if (result === undefined) throw unsupported();
      if (result.outcome === 'skipped') {
        return { outcome: 'skipped', blockingTaskId: result.blockingWorkflowId ?? null };
      }
      return { outcome: result.outcome, taskId: result.workflowId };
    } catch (error) {
      return faultOf(error, input.scheduleId);
    }
  },
});

const missedInput = z.object({
  scheduleId: scheduleIdentifier,
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('The most rows to return, newest first. Defaults to the 100 a schedule keeps.'),
});
const missedOutput = z.object({
  missed: z.array(
    z.object({
      scheduleId: z.string(),
      /** The schedule’s owner of record, who the row belongs to. */
      owner: z.string(),
      /** When the miss is recorded at: the occurrence’s time for `late`, the end of the gap for `dst-gap`. */
      occurrence: z.string(),
      reason: z.enum(['late', 'dst-gap']),
      /** How many fires the row stands for. */
      count: z.number().int(),
      recordedAt: z.string(),
    }),
  ),
});

export const schedulesMissedOperation = defineOperation<
  typeof missedInput,
  typeof missedOutput,
  BureauSchedulesOperationHost
>({
  name: 'bureau.schedules.missed',
  authorize: authorizeWorkspaceOperation('bureau.schedules.missed'),
  mcpExposable: false,
  summary: 'List the fires a schedule missed',
  description:
    'Lists the fires one of the caller’s own schedules missed, newest first; a caller holding `bureau.schedules:read` lists any owner’s. A row is `late` when the engine was down (or too slow) and the fire was dropped, or `dst-gap` when the clock sprang forward past the schedule’s time in its time zone. A schedule keeps its latest 100 rows, while its view’s `missedFireCount` keeps counting; a row carries the schedule’s `owner`. Another owner’s schedule answers as a missing one does.',
  destructive: false,
  tags: ['Schedules'],
  inputSchema: missedInput,
  outputSchema: missedOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const owner = await ownerFor(host, principal, input.scheduleId, 'bureau.schedules:read', true);
    const rows = await host.schedules.missed(
      input.scheduleId,
      input.limit === undefined ? undefined : { limit: input.limit },
    );
    if (rows === undefined) throw unsupported();
    if (rows === null) throw resourceNotFound('schedule', input.scheduleId);
    return {
      missed: rows.map((row) => ({
        scheduleId: row.scheduleId,
        owner,
        occurrence: iso(row.occurrence)!,
        reason: row.reason,
        count: row.count,
        recordedAt: iso(row.recordedAt)!,
      })),
    };
  },
});

const updateInput = z.object({
  scheduleId: scheduleIdentifier,
  spec: z
    .string()
    .min(1)
    .max(256)
    .describe(
      'The schedule’s new cadence, a cron expression or a duration. The cadence is replaced wholesale, so it is always given.',
    ),
  description: z
    .string()
    .max(2_000)
    .optional()
    .describe('The schedule’s new description; left as it was when omitted.'),
  overlap: z
    .enum(['skip', 'allow'])
    .optional()
    .describe(
      'The schedule’s new overlap policy: `skip` or `allow` (refused for a schedule with a recurring session); left as it was when omitted.',
    ),
  timeZone: timeZoneField.optional(),
  agentName: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('The catalog agent each fire runs from now on; left as it was when omitted.'),
  workflowType: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      'The workflow each fire starts from now on, judged as `bureau.schedules.create` judges it; left as it was when omitted. Given to a schedule that runs an agent, it changes the schedule to run the workflow.',
    ),
  workflowInput: z
    .json()
    .optional()
    .describe(
      'The JSON input the workflow receives from now on, which its `inputSchema` must accept; `null` is a value. Left as it was when omitted, except that a different `workflowType` starts with `null`.',
    ),
  input: z
    .string()
    .min(1)
    .max(100_000)
    .optional()
    .describe(
      'The text each fire sends from now on, replacing the schedule’s text; an input that carries media keeps it. Left as it was when omitted.',
    ),
  sessionId: z
    .string()
    .min(1)
    .max(256)
    .nullable()
    .optional()
    .describe(
      'The session each fire continues from now on, or `null` to make every fire a fresh session; left as it was when omitted. Refused with an overlap of `allow`.',
    ),
  continueChat: z
    .boolean()
    .optional()
    .describe(
      'Start a new chat that every fire continues from now on, which the Bureau names itself and the first fire makes, replacing the schedule’s chat. Refused together with `sessionId` and with an overlap of `allow`.',
    ),
  expectedRevision,
});

export const schedulesUpdateOperation = defineOperation<
  typeof updateInput,
  typeof receiptSchema,
  BureauSchedulesOperationHost
>({
  name: 'bureau.schedules.update',
  authorize: authorizeWorkspaceOperation('bureau.schedules.update'),
  mcpExposable: false,
  summary:
    'Change a schedule’s cadence, description, overlap policy, time zone, target, text, workflow input, or session',
  description: `Replaces a schedule’s cadence with \`spec\` (a cron expression or a duration; an interval counts from now), and changes its \`description\`, \`overlap\`, and \`timeZone\` when they are given (a zone left out is kept; an unknown one, or one other than \`UTC\` given with an interval, is \`InvalidParams\` on \`timeZone\`). It also changes the run each fire starts when it is named: \`agentName\` (a catalog agent; one that is not there is \`NotFound\`), \`input\` (the text each fire sends), and \`sessionId\` (the session each fire continues, or \`null\` for a fresh one each time). \`workflowType\` and \`workflowInput\` change a schedule to start a workflow, or the workflow it starts, as \`bureau.schedules.create\` describes them; the workflow is judged as \`bureau.workflows.start\` judges it, so one that is not there or that the caller could not start is \`NotFound\`. A schedule changes between an agent and a workflow in one write with the new cadence, fenced by \`expectedRevision\`: to a workflow with \`workflowType\` (and \`workflowInput\`; a different workflow starts with \`null\` when it is left out), and to an agent with \`agentName\` and its \`input\`. \`workflowType\` and \`workflowInput\` are refused (\`InvalidParams\`) with \`agentName\`, \`input\`, \`sessionId\`, and \`continueChat\`. What is left out is kept, the owner is never changed, and \`overlap: "allow"\` is refused for a schedule with a recurring session. An update always counts as a change. ${STALE_NOTE}`,
  destructive: true,
  tags: ['Schedules'],
  inputSchema: updateInput,
  outputSchema: receiptSchema,
  producibleFaults: [
    'InvalidParams',
    'NotFound',
    'Conflict',
    'StaleRevision',
    'UnsupportedCapability',
  ],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    await ownerFor(host, principal, input.scheduleId, 'bureau.schedules:write');
    refuseMixedTarget(input, ['input', 'sessionId', 'continueChat']);
    assertKnownTimeZone(input.timeZone);
    // A workflow target is judged as `bureau.workflows.start` judges it, for the one that is named
    // and for a `workflowInput` given to the workflow a schedule already runs.
    if (input.workflowType !== undefined) {
      workflowsForSchedule(host, principal, input.workflowType);
    } else if (input.workflowInput !== undefined) {
      const stored = await host.schedules.get(input.scheduleId);
      if (stored === null || stored === undefined) {
        throw resourceNotFound('schedule', input.scheduleId);
      }
      // A schedule that runs an agent names no workflow to judge: the update answers it as a bad
      // request, whatever the caller may start.
      const workflowType = bureauNameOf(stored.workflowType);
      if (workflowType !== AGENT_SCHEDULE_WORKFLOW_TYPE) {
        workflowsForSchedule(host, principal, workflowType);
      }
    }
    // An agent the caller may not name (COR-1904) is as unknown to it as one the catalog lacks.
    if (
      input.agentName !== undefined &&
      (!host.agentVisibility.mayName(principal, input.agentName) ||
        !host.schedules.hasAgent(input.agentName))
    ) {
      throw resourceNotFound('agent', input.agentName);
    }
    try {
      const done = await host.schedules.update(
        input.scheduleId,
        {
          spec: input.spec,
          ...(input.workflowType === undefined ? {} : { workflowType: input.workflowType }),
          ...(input.workflowInput === undefined ? {} : { workflowInput: input.workflowInput }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.overlap === undefined ? {} : { overlap: input.overlap }),
          ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
          ...(input.agentName === undefined ? {} : { agentName: input.agentName }),
          ...(input.input === undefined ? {} : { input: input.input }),
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
          ...(input.continueChat === true ? { continueChat: true } : {}),
        },
        { expectedRevision: input.expectedRevision, actor: actorOf(principal) },
      );
      if (done === undefined) throw unsupported();
    } catch (error) {
      return faultOf(error, input.scheduleId);
    }
    return receiptOf(host, input.scheduleId);
  },
});

/** The schedule operations, in the order the handler serves them. */
export const bureauSchedulesOperations = [
  schedulesListOperation,
  schedulesGetOperation,
  schedulesCreateOperation,
  schedulesPauseOperation,
  schedulesResumeOperation,
  schedulesCancelOperation,
  schedulesUpdateOperation,
  schedulesSkipNextOperation,
  schedulesUnskipOperation,
  schedulesRunNowOperation,
  schedulesMissedOperation,
] as const;
