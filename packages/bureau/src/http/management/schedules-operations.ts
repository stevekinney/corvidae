/**
 * `bureau.schedules.*`: the durable schedules of a Bureau (COR-1482), over the Bureau's own
 * schedule methods.
 *
 * A schedule belongs to the principal that created it. A caller reads and changes its own
 * schedules without any scope; `bureau.schedules:read` grants every owner's to `list` and `get`,
 * and `bureau.schedules:write` grants `pause`, `resume`, `cancel`, and `update`, and neither
 * implies the other. A schedule the caller may not see, or change, is answered exactly as a
 * missing one. The schedule of a workflow file belongs to the deployment's owner of record and to
 * its file: it is read here like any schedule, and a write to it is refused as if it did not
 * exist, because `bureau.workflows.*` is the only way to change it. `create` makes a schedule the
 * caller owns, so it needs no scope; the owner comes from the caller's credential.
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
 * whoever may see the schedule, as `bureau.contexts` serves `title` and `lastMessagePreview`; the
 * rest of the input, and its session, stay in storage. A view also names the agent each fire runs
 * (`agentName`, `null` for a workflow file's schedule, which runs none), because that names a
 * resource and carries no content.
 *
 * @module schedules-operations
 */

import {
  defineOperation,
  type OperationFault,
  type Principal,
  type ScheduleSummary,
  ScheduleStaleRevisionError,
} from '@lostgradient/weft';
import { z } from 'zod';

import {
  BureauError,
  ScheduleLocatorUnavailableError,
  UnknownScheduleAgentError,
} from '../../create-bureau.ts';
import { scheduleInputPreview } from '../../schedule-input-preview.ts';
import type { BureauSchedules } from '../../types.ts';
import type { BureauScope } from '../bureau-scopes.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import {
  DEFAULT_PAGE_LIMIT,
  pageFields,
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** What the schedule operations read from the handler's `host`. */
export type BureauSchedulesOperationHost = BureauOwnershipHost & {
  readonly schedules: Pick<
    BureauSchedules,
    | 'create'
    | 'get'
    | 'list'
    | 'pause'
    | 'resume'
    | 'cancel'
    | 'update'
    | 'agentName'
    | 'inputPreview'
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
  /** The start of the text each fire sends, at most 500 characters; `null` when the schedule sends none. */
  inputPreview: z.string().nullable(),
  workflowType: z.string(),
  description: z.string().nullable(),
  /** Set for a cron schedule, `null` for an interval one. */
  cronExpression: z.string().nullable(),
  /** Set for an interval schedule, `null` for a cron one. */
  intervalMs: z.number().nullable(),
  status: scheduleStatus,
  overlap: z.enum(['skip', 'queue', 'cancel-running', 'allow']),
  revision: z.number().int(),
  nextFireAt: z.string().nullable(),
  lastFireAt: z.string().nullable(),
  missedFireCount: z.number().int(),
  skippedCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
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
): z.infer<typeof scheduleViewSchema> {
  return {
    id: summary.id,
    owner,
    agentName: agentName ?? null,
    inputPreview: inputPreview ?? null,
    workflowType: summary.workflowType,
    description: summary.description ?? null,
    cronExpression: summary.cronExpression ?? null,
    intervalMs: summary.intervalMs ?? null,
    status: summary.status,
    overlap: summary.overlap,
    revision: summary.revision,
    nextFireAt: iso(summary.nextFireAt),
    lastFireAt: iso(summary.lastFireAt),
    missedFireCount: summary.missedFireCount,
    skippedCount: summary.skippedCount,
    createdAt: iso(summary.createdAt)!,
    updatedAt: iso(summary.updatedAt)!,
  };
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
  if (error instanceof UnknownScheduleAgentError) throw resourceNotFound('agent', error.agentName);
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
    if (message.includes('cannot be resumed')) {
      throw {
        code: 'Conflict',
        message: error.message,
        data: { reason: 'schedule-cancelled' },
      } satisfies OperationFault;
    }
    if (message.includes('cron') || message.includes('interval') || message.includes('must be')) {
      throw invalidParams('spec', error.message);
    }
  }
  throw error;
}

/**
 * The owner of schedule `scheduleId` when `principal` may use `operatorScope` on it, and
 * `NotFound` otherwise: for a caller who may not, a schedule that is not there, and one that is
 * not a Bureau schedule, are the same answer.
 */
async function ownerFor(
  host: BureauSchedulesOperationHost,
  principal: Principal,
  scheduleId: string,
  operatorScope: BureauScope,
): Promise<string> {
  const owner = await host.schedules.owner(scheduleId);
  if (
    owner === undefined ||
    !host.ownership.mayAccess({ principal, resourceOwner: owner, operatorScope })
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
      principal.method !== 'unauthenticated' && principal.hasScope('bureau.schedules:read');
    const caller = ownerOfPrincipal(principal);
    if (!everyOwner && caller === undefined) return { schedules: [], nextOffset: null };
    const visible: z.infer<typeof scheduleViewSchema>[] = [];
    for (let offset = 0; ; offset += SCAN_PAGE_SIZE) {
      const page = await host.schedules.list({
        ...(input.status === undefined ? {} : { status: input.status }),
        limit: SCAN_PAGE_SIZE,
        offset,
      });
      if (page === undefined) throw unsupported();
      for (const summary of page.items) {
        const owner = await host.schedules.owner(summary.id);
        if (owner !== undefined && (everyOwner || owner === caller)) {
          visible.push(
            viewOf(
              summary,
              owner,
              await host.schedules.agentName(summary.id),
              await host.schedules.inputPreview(summary.id),
            ),
          );
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
    );
  },
});

const createInput = z.object({
  agentName: z.string().min(1).max(256).describe('The catalog agent each fire runs.'),
  spec: z
    .string()
    .min(1)
    .max(256)
    .describe('A cron expression, or a duration such as `30s`, `6h`, or `1d`.'),
  input: z.string().min(1).max(100_000).describe('The text delivered to the agent each fire.'),
  description: z.string().max(2_000).optional().describe('A description of the schedule.'),
  sessionId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('A session each fire continues; without one, every fire is a fresh session.'),
  overlap: z
    .enum(['skip', 'allow'])
    .optional()
    .describe(
      'Whether a fire starts while the previous one is still running: `skip` does not, `allow` does (refused with a `sessionId`). Defaults to `skip`.',
    ),
});

export const schedulesCreateOperation = defineOperation<
  typeof createInput,
  typeof scheduleViewSchema,
  BureauSchedulesOperationHost
>({
  name: 'bureau.schedules.create',
  mcpExposable: false,
  summary: 'Create a schedule',
  description:
    'Creates a schedule that runs the catalog agent `agentName` with the text `input` on `spec`, a cron expression or a duration. The caller owns it, so no scope is needed; every fire is a task the owner can list, read, observe, and cancel. `sessionId` makes each fire continue one session (`overlap: "allow"` is then refused), and `overlap` defaults to `skip`. An agent that is not in the catalog is `NotFound`; a `spec` that is not a cadence, or a combination Bureau refuses, is `InvalidParams`. Answers the schedule’s view, whose `revision` is `1`.',
  destructive: true,
  tags: ['Schedules'],
  inputSchema: createInput,
  outputSchema: scheduleViewSchema,
  producibleFaults: [
    'InvalidParams',
    'Forbidden',
    'NotFound',
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
    if (!host.schedules.hasAgent(input.agentName)) throw resourceNotFound('agent', input.agentName);
    try {
      const summary = await host.schedules.create({
        agentName: input.agentName,
        spec: input.spec,
        input: input.input,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.overlap === undefined ? {} : { overlap: input.overlap }),
        principal: owner,
      });
      if (summary === undefined) throw unsupported();
      // The preview comes from the request's own text, never a second read of storage: a read that
      // failed after the schedule was made would hide the schedule from a retry (COR-411).
      return viewOf(summary, owner, input.agentName, scheduleInputPreview(input.input));
    } catch (error) {
      return faultOf(error, input.agentName);
    }
  },
});

const guardedInput = z.object({ scheduleId: scheduleIdentifier, expectedRevision });

function defineGuardedWrite(
  name: string,
  summary: string,
  description: string,
  run: (
    schedules: BureauSchedulesOperationHost['schedules'],
    scheduleId: string,
    guard: { readonly expectedRevision: number | undefined },
  ) => Promise<true | undefined>,
) {
  return defineOperation<typeof guardedInput, typeof receiptSchema, BureauSchedulesOperationHost>({
    name,
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

export const schedulesCancelOperation = defineGuardedWrite(
  'bureau.schedules.cancel',
  'Cancel a schedule',
  `Cancels a schedule for good: its record stays, as \`cancelled\`, and it starts no new fire. Cancelling a cancelled schedule changes nothing. ${STALE_NOTE}`,
  (schedules, id, guard) => schedules.cancel(id, guard),
);

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
  expectedRevision,
});

export const schedulesUpdateOperation = defineOperation<
  typeof updateInput,
  typeof receiptSchema,
  BureauSchedulesOperationHost
>({
  name: 'bureau.schedules.update',
  mcpExposable: false,
  summary: 'Change a schedule’s cadence, description, or overlap policy',
  description: `Replaces a schedule’s cadence with \`spec\` (a cron expression or a duration; an interval counts from now), and changes its \`description\` and \`overlap\` when they are given. Its agent, input, owner, and session are not changed, and \`overlap: "allow"\` is refused for a schedule with a recurring session. An update always counts as a change. ${STALE_NOTE}`,
  destructive: true,
  tags: ['Schedules'],
  inputSchema: updateInput,
  outputSchema: receiptSchema,
  producibleFaults: ['InvalidParams', 'NotFound', 'StaleRevision', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    await ownerFor(host, principal, input.scheduleId, 'bureau.schedules:write');
    try {
      const done = await host.schedules.update(
        input.scheduleId,
        {
          spec: input.spec,
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.overlap === undefined ? {} : { overlap: input.overlap }),
        },
        { expectedRevision: input.expectedRevision },
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
] as const;
