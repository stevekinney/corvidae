import { z } from 'zod';
import { assertOperationEngineMethods } from './operation-helpers.ts';

import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { mapScheduleErrorToFault } from './schedule-faults.ts';

const skipNextScheduleInput = z.object({
  scheduleId: z.string().min(1).describe('Id of the active schedule whose next run to skip.'),
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
    'changes nothing. Faults with NotFound when no schedule with the given id exists, and with ' +
    'Conflict when the schedule is paused or cancelled.',
  destructive: false,
  tags: ['Schedules'],
  inputSchema: skipNextScheduleInput,
  outputSchema: skipNextScheduleOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['schedules:write'] } },
  discoverable: true,
  producibleFaults: ['NotFound', 'Conflict'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine }): Promise<SkipNextScheduleOutput> => {
    assertOperationEngineMethods(engine, ['skipNextScheduleOccurrence']);

    try {
      await engine.skipNextScheduleOccurrence(input.scheduleId);
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
  },
  extractInput: async (_request, pathParams) => ({
    scheduleId: pathParams['id'] ?? '',
  }),
  success: { kind: 'empty', status: 204 },
};
