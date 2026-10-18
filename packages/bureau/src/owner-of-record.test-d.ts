// Type-level tripwire (COR-718): the in-process entry points that create a
// resource take its owner as an optional `principal` string, and
// `Bureau.getOwner` names the kinds whose owner it reads. If this file stops
// compiling, an owner entry point or the closed list of owned kinds changed.

import type { ScheduledAgentRunInput } from '@lostgradient/operative';

import type { BureauGoalRequest } from './goal-types.ts';
import type {
  Bureau,
  CreateRunRequest,
  DurableScheduleDefinition,
  OwnedResource,
} from './types.ts';

declare const bureau: Bureau;

// `CreateRunRequest.principal` is the owner of record, and optional.
export const withOwner: CreateRunRequest = { message: 'hello', principal: 'api-key:alice' };
export const withoutOwner: CreateRunRequest = { message: 'hello' };
// @ts-expect-error -- the owner is text
export const numericOwner: CreateRunRequest = { message: 'hello', principal: 7 };

// `DurableScheduleDefinition.principal` is the schedule's owner, and optional.
export const scheduleOwner: DurableScheduleDefinition = {
  agentName: 'worker',
  input: 'tick',
  spec: '1h',
  principal: 'api-key:alice',
};
export const numericScheduleOwner: DurableScheduleDefinition = {
  agentName: 'worker',
  input: 'tick',
  spec: '1h',
  // @ts-expect-error -- the owner is text
  principal: 7,
};

// The schedule's input carries the owner beside `scheduleId`.
export const scheduledInput: ScheduledAgentRunInput = {
  agentName: 'worker',
  input: 'tick',
  scheduleId: 'schedule-1',
  principal: 'api-key:alice',
};

// The goal request's existing `principal` is the goal's owner: there is no second field.
export const goalOwner: BureauGoalRequest<'worker'>['principal'] = 'api-key:alice';

// `getOwner` reads a closed list of kinds, and answers text or nothing.
export const owner: Promise<string | undefined> = bureau.getOwner({ kind: 'run', id: 'run-1' });
export const audited: OwnedResource = { kind: 'audit', runId: 'schedule:schedule-1' };
// @ts-expect-error -- a delivery record has no owner of record
bureau.getOwner({ kind: 'delivery', id: 'delivery-1' });
// @ts-expect-error -- an audit entry is named by its run id
bureau.getOwner({ kind: 'audit', id: 'run-1' });
