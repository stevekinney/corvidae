/**
 * COR-1482 — `bureau.schedules.*` over a real Bureau and its handler: each operation, the owner
 * predicate and the operator scopes (read and write apart), `expectedRevision`, and a workflow
 * file's schedule, which belongs to its file.
 */
import { createAgent } from '@lostgradient/operative';
import { handleRequest, unauthenticatedLocalAuthContext } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { AGENT_STEP } from '../../testing/workflow-file-fixtures.test-support.ts';
import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import {
  answering,
  as,
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
    expect(JSON.stringify(read.result)).not.toContain('PROMPT-SENTINEL-7c1d');
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
    expect(read.result).toMatchObject({ id, status: 'active', owner: 'anonymous:local' });
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
    const awaited4 = await served.bureau.getSchedule(id);
    expect(awaited4?.status).toBe('active');
  });
});
