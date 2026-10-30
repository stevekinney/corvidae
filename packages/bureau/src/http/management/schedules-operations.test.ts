/**
 * COR-1482 — `bureau.schedules.*` over a real Bureau and its handler: each operation, the owner
 * predicate and the operator scopes (read and write apart), `expectedRevision`, and a workflow
 * file's schedule, which belongs to its file.
 */
import { createAgent } from '@lostgradient/operative';
import { handleRequest, unauthenticatedLocalAuthContext } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { AGENT_STEP } from '../../testing/workflow-file-fixtures.test-support.ts';
import { ScheduleLocatorUnavailableError } from '../../create-bureau.ts';
import { BUREAU_HANDLER_OPERATIONS, createBureauHandler } from '../create-bureau-handler.ts';
import {
  answering,
  as,
  authentication,
  openBureau,
  type OpenedBureau,
  OWNER,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';
import { bureauSchedulesOperations } from './schedules-operations.ts';
import { serveWorkflows } from './workflows-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const writer = createAgent({
  name: 'writer',
  generate: async () => ({ content: 'ok', toolCalls: [] }),
});

async function serve(): Promise<OpenedBureau> {
  const opened = await openBureau({ agents: { writer }, generate: answering() });
  cleanups.push(() => opened.dispose());
  return opened;
}

const NEW_SCHEDULE = { agentName: 'writer', spec: '1h', input: 'PROMPT-SENTINEL-7c1d' };

async function createdBy(opened: OpenedBureau, key: string, extra: object = {}): Promise<string> {
  const body = await rpc(
    opened.handler,
    'bureau.schedules.create',
    { ...NEW_SCHEDULE, ...extra },
    key,
  );
  expect(body.error).toBeUndefined();
  return body.result!['id'] as string;
}

const status = (body: RpcBody) => body.error?.data?.httpStatus;

describe('the operations list', () => {
  it('serves the seven schedule operations, registered and listed in OpenRPC', async () => {
    const names = [
      'bureau.schedules.list',
      'bureau.schedules.get',
      'bureau.schedules.create',
      'bureau.schedules.pause',
      'bureau.schedules.resume',
      'bureau.schedules.cancel',
      'bureau.schedules.update',
    ];
    expect(bureauSchedulesOperations.map((operation) => operation.name)).toEqual(names);
    for (const operation of bureauSchedulesOperations) {
      expect(BUREAU_HANDLER_OPERATIONS).toContain(operation);
    }
    const opened = await serve();
    const response = await opened.handler(
      new Request('http://localhost/openrpc.json', { headers: as('operator-key') }),
    );
    const document = (await response.json()) as { methods: Array<{ name: string }> };
    for (const name of names) {
      expect(document.methods.map((method) => method.name)).toContain(name);
    }
  });
});

describe('each schedule operation, as the owner', () => {
  it('creates a schedule owned by the caller, and reads it back with its revision', async () => {
    const opened = await serve();
    const created = await rpc(
      opened.handler,
      'bureau.schedules.create',
      { ...NEW_SCHEDULE, description: 'hourly tick' },
      'alice-key',
    );
    expect(created.result).toMatchObject({
      owner: OWNER.alice,
      agentName: 'writer',
      inputPreview: 'PROMPT-SENTINEL-7c1d',
      status: 'active',
      revision: 1,
      description: 'hourly tick',
      intervalMs: 3_600_000,
      cronExpression: null,
      overlap: 'skip',
    });
    const id = created.result!['id'] as string;

    const read = await rpc(opened.handler, 'bureau.schedules.get', { scheduleId: id }, 'alice-key');
    expect(read.result).toEqual(created.result);
    const listed = await rpc(opened.handler, 'bureau.schedules.list', {}, 'alice-key');
    expect((listed.result!['schedules'] as Array<{ id: string }>).map((entry) => entry.id)).toEqual(
      [id],
    );
    expect(listed.result!['nextOffset']).toBeNull();
  });

  it('pauses, resumes, and cancels it, each receipt carrying the new revision', async () => {
    const opened = await serve();
    const id = await createdBy(opened, 'alice-key');
    const call = (method: string, extra: object = {}) =>
      rpc(opened.handler, `bureau.schedules.${method}`, { scheduleId: id, ...extra }, 'alice-key');

    const awaited1 = await call('pause');
    expect(awaited1.result).toEqual({ id, status: 'paused', revision: 2 });
    const awaited2 = await call('resume');
    expect(awaited2.result).toEqual({ id, status: 'active', revision: 3 });
    const awaited3 = await call('cancel');
    expect(awaited3.result).toEqual({ id, status: 'cancelled', revision: 4 });
  });

  it('updates its cadence, description, and overlap policy', async () => {
    const opened = await serve();
    const id = await createdBy(opened, 'alice-key');

    const updated = await rpc(
      opened.handler,
      'bureau.schedules.update',
      { scheduleId: id, spec: '*/15 * * * *', description: 'quarter hourly', overlap: 'allow' },
      'alice-key',
    );
    expect(updated.result).toEqual({ id, status: 'active', revision: 2 });
    const read = await rpc(opened.handler, 'bureau.schedules.get', { scheduleId: id }, 'alice-key');
    expect(read.result).toMatchObject({
      cronExpression: '*/15 * * * *',
      intervalMs: null,
      description: 'quarter hourly',
      overlap: 'allow',
      revision: 2,
    });
  });

  it('answers an agent that is not in the catalog, and a spec that is not a schedule, as the typed faults', async () => {
    const opened = await serve();
    const unknown = await rpc(
      opened.handler,
      'bureau.schedules.create',
      { ...NEW_SCHEDULE, agentName: 'nobody' },
      'alice-key',
    );
    expect(status(unknown)).toBe(404);
    expect(JSON.stringify(unknown.error)).toContain('nobody');
    const malformed = await rpc(
      opened.handler,
      'bureau.schedules.create',
      { ...NEW_SCHEDULE, spec: 'not a schedule' },
      'alice-key',
    );
    expect(status(malformed)).toBe(400);
    const recurring = await rpc(
      opened.handler,
      'bureau.schedules.create',
      { ...NEW_SCHEDULE, sessionId: 'digest', overlap: 'allow' },
      'alice-key',
    );
    expect(status(recurring)).toBe(400);
    const listed = await rpc(opened.handler, 'bureau.schedules.list', {}, 'alice-key');
    expect(listed.result!['schedules']).toEqual([]);
  });
});

describe('a schedule’s time zone (COR-1820)', () => {
  const WEEKDAYS = { ...NEW_SCHEDULE, spec: '0 9 * * 1-5' };

  it('creates a schedule in the zone it names, keeps it through an update that omits it, and changes it when given', async () => {
    const opened = await serve();
    const created = await rpc(
      opened.handler,
      'bureau.schedules.create',
      { ...WEEKDAYS, timeZone: 'America/Los_Angeles' },
      'alice-key',
    );
    expect(created.result).toMatchObject({
      cronExpression: '0 9 * * 1-5',
      timeZone: 'America/Los_Angeles',
    });
    const id = created.result!['id'] as string;
    const read = async () => {
      const body = await rpc(
        opened.handler,
        'bureau.schedules.get',
        { scheduleId: id },
        'alice-key',
      );
      return body.result;
    };

    await rpc(
      opened.handler,
      'bureau.schedules.update',
      { scheduleId: id, spec: '0 10 * * 1-5' },
      'alice-key',
    );
    expect(await read()).toMatchObject({
      cronExpression: '0 10 * * 1-5',
      timeZone: 'America/Los_Angeles',
    });

    const changed = await rpc(
      opened.handler,
      'bureau.schedules.update',
      { scheduleId: id, spec: '0 10 * * 1-5', timeZone: 'Europe/Berlin' },
      'alice-key',
    );
    expect(changed.error).toBeUndefined();
    expect(await read()).toMatchObject({ timeZone: 'Europe/Berlin' });
  });

  it('shows a schedule created without a zone, and an interval one, in UTC', async () => {
    const opened = await serve();
    const cron = await rpc(opened.handler, 'bureau.schedules.create', WEEKDAYS, 'alice-key');
    const interval = await rpc(
      opened.handler,
      'bureau.schedules.create',
      NEW_SCHEDULE,
      'alice-key',
    );
    expect(cron.result).toMatchObject({ timeZone: 'UTC' });
    expect(interval.result).toMatchObject({ timeZone: 'UTC' });
  });

  it('answers a zone that is not an IANA name as InvalidParams on timeZone, on create and on update, and writes nothing', async () => {
    const opened = await serve();
    const refusals = [
      await rpc(
        opened.handler,
        'bureau.schedules.create',
        { ...WEEKDAYS, timeZone: 'Mars/Olympus' },
        'alice-key',
      ),
    ];
    const id = await createdBy(opened, 'alice-key', { spec: '0 9 * * 1-5' });
    refusals.push(
      await rpc(
        opened.handler,
        'bureau.schedules.update',
        { scheduleId: id, spec: '0 9 * * 1-5', timeZone: 'Mars/Olympus' },
        'alice-key',
      ),
    );
    for (const refusal of refusals) {
      expect(status(refusal)).toBe(400);
      expect(refusal.error?.data?.['issues']).toContainEqual(
        expect.objectContaining({ path: ['timeZone'] }),
      );
    }
    const listed = await rpc(opened.handler, 'bureau.schedules.list', {}, 'alice-key');
    expect(listed.result!['schedules']).toHaveLength(1);
    const read = await rpc(opened.handler, 'bureau.schedules.get', { scheduleId: id }, 'alice-key');
    expect(read.result).toMatchObject({ revision: 1, timeZone: 'UTC' });
  });

  it('answers a zone given with an interval as InvalidParams on timeZone', async () => {
    const opened = await serve();
    const refusal = await rpc(
      opened.handler,
      'bureau.schedules.create',
      { ...NEW_SCHEDULE, timeZone: 'America/Los_Angeles' },
      'alice-key',
    );
    expect(status(refusal)).toBe(400);
    expect(refusal.error?.data?.['issues']).toContainEqual(
      expect.objectContaining({ path: ['timeZone'] }),
    );
  });
});

describe('the agent a schedule runs', () => {
  it('is named by the view of every read, and the view carries only the start of the input', async () => {
    const opened = await serve();
    const id = await createdBy(opened, 'alice-key', { description: 'hourly tick' });

    const read = await rpc(opened.handler, 'bureau.schedules.get', { scheduleId: id }, 'alice-key');
    expect(read.result).toMatchObject({ id, agentName: 'writer' });
    const listed = await rpc(opened.handler, 'bureau.schedules.list', {}, 'alice-key');
    expect(
      (listed.result!['schedules'] as Array<{ id: string; agentName: string }>).map((entry) => [
        entry.id,
        entry.agentName,
      ]),
    ).toEqual([[id, 'writer']]);
    // The name and the start of the text leave the stored input; a session it continues does not.
    expect(read.result).toMatchObject({ inputPreview: 'PROMPT-SENTINEL-7c1d' });
    expect(
      (listed.result!['schedules'] as Array<{ inputPreview: string }>).map(
        (entry) => entry.inputPreview,
      ),
    ).toEqual(['PROMPT-SENTINEL-7c1d']);
  });

  it('cuts a long input to 500 characters ending in an ellipsis, and keeps a short one whole', async () => {
    const opened = await serve();
    const long = `${'x'.repeat(600)}-TAIL-SENTINEL`;
    const created = await rpc(
      opened.handler,
      'bureau.schedules.create',
      { ...NEW_SCHEDULE, input: long },
      'alice-key',
    );
    const preview = created.result!['inputPreview'] as string;
    expect(preview).toBe(`${'x'.repeat(499)}…`);
    const listed = await rpc(opened.handler, 'bureau.schedules.list', {}, 'alice-key');
    expect(JSON.stringify(listed.result)).not.toContain('TAIL-SENTINEL');
  });

  it('cuts on a character, never through an emoji, so the preview is well formed on the wire', async () => {
    const opened = await serve();
    // The emoji's code units sit at 498 and 499, the place a code-unit slice used to split it.
    const created = await rpc(
      opened.handler,
      'bureau.schedules.create',
      { ...NEW_SCHEDULE, input: `${'x'.repeat(498)}😀${'y'.repeat(50)}` },
      'alice-key',
    );
    const preview = created.result!['inputPreview'] as string;
    expect(preview.isWellFormed()).toBe(true);
    expect(preview).toBe(`${'x'.repeat(498)}😀…`);
    expect(Array.from(preview)).toHaveLength(500);
    const id = created.result!['id'] as string;
    const read = await rpc(opened.handler, 'bureau.schedules.get', { scheduleId: id }, 'alice-key');
    expect(read.result!['inputPreview']).toBe(preview);
  });

  it('answers a create from its own request, and reads no stored input back to build the preview', async () => {
    const opened = await serve();
    const reads: string[] = [];
    const watched = new Proxy(opened.bureau, {
      get(target, key) {
        if (key !== 'schedules') return Reflect.get(target, key, target) as unknown;
        return {
          ...target.schedules,
          inputPreview: async (scheduleId: string) => {
            reads.push(scheduleId);
            throw new Error('a create must not read the stored input back');
          },
        };
      },
    });
    const handler = createBureauHandler(watched, { authentication });

    const created = await rpc(handler, 'bureau.schedules.create', NEW_SCHEDULE, 'alice-key');

    expect(created.error).toBeUndefined();
    expect(created.result).toMatchObject({ inputPreview: 'PROMPT-SENTINEL-7c1d' });
    expect(reads).toEqual([]);
  });

  it('has no preview for a schedule whose input is media alone', async () => {
    const opened = await serve();
    const summary = await opened.bureau.schedules.create({
      agentName: 'writer',
      spec: '1h',
      input: [{ type: 'image', source: { kind: 'managed-asset', assetId: 'asset-media-only' } }],
      principal: OWNER.alice,
    });
    const id = summary!.id;

    const read = await rpc(opened.handler, 'bureau.schedules.get', { scheduleId: id }, 'alice-key');
    expect(read.error).toBeUndefined();
    expect(read.result).toMatchObject({ id, agentName: 'writer', inputPreview: null });
    const listed = await rpc(opened.handler, 'bureau.schedules.list', {}, 'alice-key');
    expect(
      (listed.result!['schedules'] as Array<{ inputPreview: string | null }>).map(
        (entry) => entry.inputPreview,
      ),
    ).toEqual([null]);
  });

  it('never exposes the session a schedule continues in any field of create, get, or list', async () => {
    const opened = await serve();
    const session = 'SESSION-SENTINEL-4e2a';
    const created = await rpc(
      opened.handler,
      'bureau.schedules.create',
      { ...NEW_SCHEDULE, sessionId: session },
      'alice-key',
    );
    expect(created.error).toBeUndefined();
    const id = created.result!['id'] as string;
    const read = await rpc(opened.handler, 'bureau.schedules.get', { scheduleId: id }, 'alice-key');
    const listed = await rpc(opened.handler, 'bureau.schedules.list', {}, 'alice-key');

    for (const body of [created, read, listed]) {
      expect(JSON.stringify(body.result)).not.toContain(session);
    }
    expect(Object.keys(created.result!)).not.toContain('sessionId');
    expect(Object.keys(read.result!)).not.toContain('sessionId');
  });

  it('is still named after the schedule is paused or its cadence changes, and for a cancelled one', async () => {
    const opened = await serve();
    const id = await createdBy(opened, 'alice-key');
    const call = (method: string, extra: object = {}) =>
      rpc(opened.handler, `bureau.schedules.${method}`, { scheduleId: id, ...extra }, 'alice-key');
    await call('update', { spec: '2h' });
    await call('pause');
    await call('cancel');
    const read = await rpc(opened.handler, 'bureau.schedules.get', { scheduleId: id }, 'alice-key');
    expect(read.result).toMatchObject({ status: 'cancelled', agentName: 'writer' });
  });
});

describe('the owner predicate and the operator scopes', () => {
  it('shows a schedule only to its owner and to bureau.schedules:read, and answers anyone else as a missing one', async () => {
    const opened = await serve();
    const id = await createdBy(opened, 'alice-key');
    const missing = await rpc(
      opened.handler,
      'bureau.schedules.get',
      { scheduleId: 'schedule-nobody' },
      'bob-key',
    );

    const denied = await rpc(opened.handler, 'bureau.schedules.get', { scheduleId: id }, 'bob-key');
    expect(status(denied)).toBe(404);
    expect(denied.error?.message?.replaceAll(id, '<id>')).toBe(
      missing.error?.message?.replaceAll('schedule-nobody', '<id>'),
    );
    const bobsList = await rpc(opened.handler, 'bureau.schedules.list', {}, 'bob-key');
    expect(bobsList.result!['schedules']).toEqual([]);

    for (const key of ['schedules-reader-key', 'operator-key']) {
      const read = await rpc(opened.handler, 'bureau.schedules.get', { scheduleId: id }, key);
      expect(read.result).toMatchObject({ id, owner: OWNER.alice });
      const listed = await rpc(opened.handler, 'bureau.schedules.list', {}, key);
      expect(
        (listed.result!['schedules'] as Array<{ id: string }>).map((entry) => entry.id),
      ).toEqual([id]);
    }
    // A write scope does not imply the read scope.
    const writerRead = await rpc(
      opened.handler,
      'bureau.schedules.get',
      { scheduleId: id },
      'schedules-writer-key',
    );
    expect(status(writerRead)).toBe(404);
  });

  it('lets another principal change a schedule only with bureau.schedules:write', async () => {
    const opened = await serve();
    const id = await createdBy(opened, 'alice-key');
    const changes = [
      ['pause', {}],
      ['resume', {}],
      ['cancel', {}],
      ['update', { spec: '2h' }],
    ] as const;

    for (const key of ['bob-key', 'schedules-reader-key']) {
      for (const [method, extra] of changes) {
        const denied = await rpc(
          opened.handler,
          `bureau.schedules.${method}`,
          { scheduleId: id, ...extra },
          key,
        );
        expect([key, method, status(denied)]).toEqual([key, method, 404]);
      }
    }
    const afterDenials = await rpc(
      opened.handler,
      'bureau.schedules.get',
      { scheduleId: id },
      'alice-key',
    );
    expect(afterDenials.result).toMatchObject({ status: 'active', revision: 1 });

    const paused = await rpc(
      opened.handler,
      'bureau.schedules.pause',
      { scheduleId: id },
      'schedules-writer-key',
    );
    expect(paused.result).toEqual({ id, status: 'paused', revision: 2 });
    const updated = await rpc(
      opened.handler,
      'bureau.schedules.update',
      { scheduleId: id, spec: '2h' },
      'schedules-writer-key',
    );
    expect(updated.result).toEqual({ id, status: 'paused', revision: 3 });
  });
});

describe('expectedRevision', () => {
  it('answers a stale revision with StaleRevision, writes nothing, and lets the current one through', async () => {
    const opened = await serve();
    const id = await createdBy(opened, 'alice-key');
    await rpc(opened.handler, 'bureau.schedules.pause', { scheduleId: id }, 'alice-key');

    for (const [method, extra] of [
      ['resume', {}],
      ['cancel', {}],
      ['pause', {}],
      ['update', { spec: '2h' }],
    ] as const) {
      const stale = await rpc(
        opened.handler,
        `bureau.schedules.${method}`,
        { scheduleId: id, expectedRevision: 1, ...extra },
        'alice-key',
      );
      expect([method, status(stale)]).toEqual([method, 409]);
      expect(stale.error?.data).toMatchObject({
        currentRevision: 2,
        expectedRevision: 1,
      });
    }
    const unchanged = await rpc(
      opened.handler,
      'bureau.schedules.get',
      { scheduleId: id },
      'alice-key',
    );
    expect(unchanged.result).toMatchObject({ status: 'paused', revision: 2 });

    const resumed = await rpc(
      opened.handler,
      'bureau.schedules.resume',
      { scheduleId: id, expectedRevision: 2 },
      'alice-key',
    );
    expect(resumed.result).toEqual({ id, status: 'active', revision: 3 });
  });

  it('refuses a resume carrying the revision read before a pause made through weft.schedules.pause, and the schedule stays paused', async () => {
    const opened = await serve();
    const id = await createdBy(opened, 'alice-key');
    const readBefore = await rpc(
      opened.handler,
      'bureau.schedules.get',
      { scheduleId: id },
      'alice-key',
    );
    const revisionRead = readBefore.result!['revision'] as number;

    const paused = await handleRequest(
      new Request(`http://localhost/v1/schedules/${encodeURIComponent(id)}/pause`, {
        method: 'POST',
      }),
      opened.bureau.durableEngine()!,
      { authContext: unauthenticatedLocalAuthContext() },
    );
    expect(paused.status).toBe(204);

    const resumed = await rpc(
      opened.handler,
      'bureau.schedules.resume',
      { scheduleId: id, expectedRevision: revisionRead },
      'alice-key',
    );
    expect(status(resumed)).toBe(409);
    expect(resumed.error?.data).toMatchObject({
      expectedRevision: revisionRead,
      currentRevision: revisionRead + 1,
    });
    const afterStale = await rpc(
      opened.handler,
      'bureau.schedules.get',
      { scheduleId: id },
      'alice-key',
    );
    expect(afterStale.result).toMatchObject({ status: 'paused', revision: revisionRead + 1 });
  });
});

describe('a workflow file’s schedule', () => {
  it('is read like any schedule, owned by the deployment, and refused every write as if it did not exist', async () => {
    const served = await serveWorkflows(cleanups);
    await served.bureau.workflows!.create('digest', {
      agent: 'writer',
      trigger: { kind: 'schedule', spec: '1h' },
      steps: [AGENT_STEP],
    });
    const id = 'bureau-workflow-schedule:digest:1';

    const read = await rpc(
      served.keyed,
      'bureau.schedules.get',
      { scheduleId: id },
      'operator-key',
    );
    // A workflow file's schedule runs no agent of its own, so its view names none.
    expect(read.result).toMatchObject({
      id,
      status: 'active',
      owner: 'anonymous:local',
      agentName: null,
      inputPreview: null,
    });
    const listed = await rpc(served.keyed, 'bureau.schedules.list', {}, 'operator-key');
    expect((listed.result!['schedules'] as Array<{ id: string }>).map((entry) => entry.id)).toEqual(
      [id],
    );
    // Alice does not own the deployment's workflows.
    const aliceReads = await rpc(
      served.keyed,
      'bureau.schedules.get',
      { scheduleId: id },
      'alice-key',
    );
    expect(status(aliceReads)).toBe(404);

    for (const [method, extra] of [
      ['pause', {}],
      ['resume', {}],
      ['cancel', {}],
      ['update', { spec: '2h' }],
    ] as const) {
      const refused = await rpc(
        served.keyed,
        `bureau.schedules.${method}`,
        { scheduleId: id, ...extra },
        'operator-key',
      );
      expect([method, status(refused)]).toEqual([method, 404]);
    }
    const awaited4 = await served.bureau.schedules.get(id);
    expect(awaited4?.status).toBe('active');
  });
});

describe('a schedule whose creation lost its locator', () => {
  it('is answered Unavailable, naming the schedule that exists, so a retry does not make a second one', async () => {
    const opened = await serve();
    const losing = new Proxy(opened.bureau, {
      get(target, key) {
        if (key !== 'schedules') return Reflect.get(target, key, target) as unknown;
        return {
          ...target.schedules,
          create: async (definition: Parameters<typeof target.schedules.create>[0]) => {
            const summary = await target.schedules.create(definition);
            throw new ScheduleLocatorUnavailableError(summary!.id);
          },
        };
      },
    });
    const handler = createBureauHandler(losing, { authentication });

    const lost = await rpc(handler, 'bureau.schedules.create', NEW_SCHEDULE, 'alice-key');

    expect(status(lost)).toBe(503);
    const listed = await rpc(opened.handler, 'bureau.schedules.list', {}, 'alice-key');
    const schedules = listed.result!['schedules'] as Array<{ id: string }>;
    expect(schedules).toHaveLength(1);
    expect(lost.error?.message).toContain(schedules[0]!.id);
    expect(lost.error?.message).toContain('bureau.schedules.get');
  });
});
