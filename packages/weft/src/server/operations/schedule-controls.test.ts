import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '@lostgradient/storage';
import { Engine } from '../../core/engine.ts';
import { workflow } from '../../core/types.ts';
import { handleRequestAsLocalUser as handleRequest } from '../local-user-request.test-support.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import {
  listScheduleMissedFiresOperation,
  listScheduleMissedFiresRestBinding,
} from './list-schedule-missed-fires.ts';
import { skipNextScheduleOperation, skipNextScheduleRestBinding } from './skip-next-schedule.ts';
import { triggerScheduleOperation, triggerScheduleRestBinding } from './trigger-schedule.ts';

// COR-1829: the three schedule controls over REST. Each is the engine method behind it, with the
// engine's refusals mapped to the faults the other schedule operations answer.

const registry = createOperationRegistry([
  skipNextScheduleOperation,
  triggerScheduleOperation,
  listScheduleMissedFiresOperation,
]);
const bindings = [
  skipNextScheduleRestBinding,
  triggerScheduleRestBinding,
  listScheduleMissedFiresRestBinding,
];

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(
    workflow({ name: 'echo' }).execute(async function* (_ctx, input: unknown) {
      return input;
    }),
  );
  return engine;
}

async function statusOf(response: Promise<Response>): Promise<number> {
  const settled = await response;
  return settled.status;
}

function post(engine: Engine, path: string): Promise<Response> {
  return handleRequest(new Request(`http://localhost${path}`, { method: 'POST' }), engine, {
    operationRegistry: registry,
    restBindings: bindings,
  });
}

function get(engine: Engine, path: string): Promise<Response> {
  return handleRequest(new Request(`http://localhost${path}`), engine, {
    operationRegistry: registry,
    restBindings: bindings,
  });
}

describe('the schedule control operations', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('skips the next run and answers 204, then 409 for a paused schedule and 404 for a missing one', async () => {
    engine = createEngine();
    await engine.schedule('echo', null, '0 * * * *', { id: 'hourly' });

    expect(await statusOf(post(engine, '/v1/schedules/hourly/skip-next'))).toBe(204);
    const skipped = await engine.getSchedule('hourly');
    expect(skipped?.skipUntil).toBe(skipped?.nextFireAt ?? undefined);

    await engine.pauseSchedule('hourly');
    const conflict = await post(engine, '/v1/schedules/hourly/skip-next');
    expect(conflict.status).toBe(409);
    expect(await statusOf(post(engine, '/v1/schedules/nope/skip-next'))).toBe(404);
  });

  it('runs a schedule now and answers what the overlap policy did', async () => {
    engine = createEngine();
    await engine.schedule('echo', null, '0 * * * *', { id: 'hourly', overlap: 'allow' });

    const response = await post(engine, '/v1/schedules/hourly/run-now');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'started', workflowId: expect.any(String) });
    await engine.cancelSchedule('hourly');
    expect(await statusOf(post(engine, '/v1/schedules/hourly/run-now'))).toBe(409);
    expect(await statusOf(post(engine, '/v1/schedules/nope/run-now'))).toBe(404);
  });

  it('lists the rows a schedule missed, honoring limit, and refuses a limit that is not a positive integer', async () => {
    engine = createEngine();
    await engine.schedule('echo', null, '0 * * * *', { id: 'hourly' });

    const empty = await get(engine, '/v1/schedules/hourly/missed?limit=5');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ missed: [] });
    expect(await statusOf(get(engine, '/v1/schedules/hourly/missed?limit=0'))).toBe(400);
    expect(await statusOf(get(engine, '/v1/schedules/nope/missed'))).toBe(404);
  });
});
