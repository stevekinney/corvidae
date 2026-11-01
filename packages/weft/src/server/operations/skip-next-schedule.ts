import { z } from 'zod';
import { assertOperationEngineMethods } from './operation-helpers.ts';

import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { mapScheduleErrorToFault } from './schedule-faults.ts';
import { parseOptionalScheduleRestBodyRecord } from './schedule-rest-body.ts';

const skipNextScheduleInput = z.object({
  scheduleId: z.string().min(1).describe('Id of the active schedule whose next run to skip.'),
  occurrence: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "The run to skip, as milliseconds since the epoch: the nextFireAt or skipUntil the caller read. Refused with Conflict when it is not the schedule's next real run.",
    ),
  expectedRevision: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Apply the skip only if the schedule is still at this revision.'),
});
const skipNextScheduleOutput = z.undefined();

export type SkipNextScheduleInput = z.infer<typeof skipNextScheduleInput>;
export type SkipNextScheduleOutput = z.infer<typeof skipNextScheduleOutput>;

export const skipNextScheduleOperation = defineOperation({
  name: 'weft.schedules.skipnext',
  mcpExposable: false,
  summary: 'Skip the next run of a recurring schedule',
  description:
    'Skip the next run of an active recurring schedule by `scheduleId`: the next occurrence that ' +
    'would start a workflow starts none, and the one after it runs as usual. In a time zone the ' +
    'next wake-up can be the end of a daylight-saving gap that starts nothing, so the occurrence ' +
    'skipped is the next real run, reported as `skipUntil` on the schedule. A run that is due but ' +
    'has not started is the next run. The skip leaves `revision` and `nextFireAt` as they are; ' +
    'skipping again before that run has passed ' +
    'changes nothing. A fire moves neither `revision` nor `status`, so the run a caller read can ' +
    'start before the skip is written: pass `occurrence`, the run to skip in milliseconds since the ' +
    'epoch, and the skip is refused with Conflict (reason `occurrence-not-next`) when that is not ' +
    "the schedule's next real run, or the run already skipped, as the write lands. Omitted, the " +
    'next run is skipped, whichever it is. Pass `expectedRevision` to refuse the skip with ' +
    'StaleRevision when the schedule has changed since it was read; the revision is checked first. ' +
    'Faults with NotFound when no schedule with the given id exists, and with Conflict when the ' +
    'schedule is paused or cancelled.',
  destructive: false,
  tags: ['Schedules'],
  inputSchema: skipNextScheduleInput,
  outputSchema: skipNextScheduleOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['schedules:write'] } },
  discoverable: true,
  producibleFaults: ['NotFound', 'Conflict', 'StaleRevision'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine }): Promise<SkipNextScheduleOutput> => {
    assertOperationEngineMethods(engine, ['skipNextScheduleOccurrence']);

    try {
      await engine.skipNextScheduleOccurrence(input.scheduleId, {
        ...(input.occurrence !== undefined && { occurrence: input.occurrence }),
        ...(input.expectedRevision !== undefined && { expectedRevision: input.expectedRevision }),
      });
      return undefined;
    } catch (error) {
      throw mapScheduleErrorToFault(input.scheduleId, error);
    }
  },
});

export const skipNextScheduleRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/schedules/:id/skip-next',
  pathParamNames: ['id'],
  operationName: 'weft.schedules.skipnext',
  inputSources: {
    scheduleId: { kind: 'path', pathParam: 'id' },
    occurrence: { kind: 'body-field', bodyField: 'occurrence' },
    expectedRevision: { kind: 'body-field', bodyField: 'expectedRevision' },
  },
  extractInput: async (request, pathParams, context) => {
    const body = await parseOptionalScheduleRestBodyRecord(request, context);
    return {
      scheduleId: pathParams['id'] ?? '',
      occurrence: body['occurrence'],
      expectedRevision: body['expectedRevision'],
    };
  },
  success: { kind: 'empty', status: 204 },
};
