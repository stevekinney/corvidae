/**
 * COR-1482 — `bureau.audit.query` over a real Bureau and its handler: what an owner and an
 * operator see, that no record carries a secret, a transcript, a tool argument, or memory
 * content, and that a cursor pages across an owner filter that drops rows.
 */
import type { GenerateContext } from '@lostgradient/operative';
import { createTool, createToolbox, type Toolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { waitForCondition } from '../../test';
import { createBureau } from '../../create-bureau.ts';
import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import { auditQueryOperation } from './audit-operations.ts';
import {
  as,
  openBureau,
  type OpenedBureau,
  OWNER,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const ARGUMENT = 'TOOL-ARGUMENT-SENTINEL-41ff';
const TRANSCRIPT = 'TRANSCRIPT-SENTINEL-7a90';
const ANSWER = 'ANSWER-SENTINEL-c2d1';
const SECRET = 'SECRET-SENTINEL-be37';
const MEMORY = 'MEMORY-SENTINEL-0d58';

type Seeded = {
  readonly opened: OpenedBureau;
  readonly aliceRun: string;
  readonly bobRun: string;
};

async function seed(): Promise<Seeded> {
  const opened = await openBureau({
    generate: async (context: GenerateContext) =>
      context.step === 0
        ? {
            content: '',
            toolCalls: [{ id: 'call-1', name: 'record-note', arguments: { note: ARGUMENT } }],
          }
        : { content: ANSWER, toolCalls: [] },
    toolbox: createToolbox([
      createTool({
        name: 'record-note',
        version: '1.0.0',
        description: 'Record a note',
        input: z.object({ note: z.string() }),
        async execute() {
          return { recorded: true };
        },
      }),
    ]) as unknown as Toolbox,
  });
  cleanups.push(() => opened.dispose());
  const alice = await opened.bureau.createRun({
    agentName: 'default',
    message: `${TRANSCRIPT} from alice`,
    principal: OWNER.alice,
  });
  const bob = await opened.bureau.createRun({
    agentName: 'default',
    message: `${TRANSCRIPT} from bob`,
    principal: OWNER.bob,
  });
  for (const run of [alice, bob]) {
    await waitForCondition(async () => {
      const completed = await opened.bureau.internals.auditTrail?.query({
        runId: run.id,
        type: 'run.completed',
      });
      return completed?.length === 1;
    }, `run ${run.id} never reached its terminal audit record`);
  }
  // Out-of-band records that carry exactly what must never be served.
  await opened.bureau.internals.auditTrail?.record({
    runId: alice.id,
    type: 'credential.rotated',
    detail: { apiKey: SECRET, authorization: `Bearer ${SECRET}` },
    principal: 'system:test',
  });
  await opened.bureau.internals.auditTrail?.record({
    runId: alice.id,
    type: 'memory.write',
    detail: { content: MEMORY },
  });
  return { opened, aliceRun: alice.id, bobRun: bob.id };
}

type View = {
  sequence: number | null;
  type: string;
  resource: string;
  principal: string | null;
  detail: Record<string, unknown> | null;
};

const recordsOf = (body: RpcBody) => (body.result!['records'] as View[]) ?? [];

describe('the operation', () => {
  it('is served, registered, and listed in OpenRPC', async () => {
    expect(BUREAU_HANDLER_OPERATIONS).toContain(auditQueryOperation);
    const opened = await openBureau();
    cleanups.push(() => opened.dispose());
    const response = await opened.handler(
      new Request('http://localhost/openrpc.json', { headers: as('operator-key') }),
    );
    const document = (await response.json()) as { methods: Array<{ name: string }> };
    expect(document.methods.map((method) => method.name)).toContain('bureau.audit.query');
  });
});

describe('bureau.audit.query without bureau.audit:read', () => {
  it('returns only the records about the caller’s own resources', async () => {
    const { opened, aliceRun, bobRun } = await seed();

    const alice = await rpc(opened.handler, 'bureau.audit.query', {}, 'alice-key');
    const bob = await rpc(opened.handler, 'bureau.audit.query', {}, 'bob-key');

    expect(recordsOf(alice).length).toBeGreaterThan(0);
    expect(new Set(recordsOf(alice).map((record) => record.resource))).toEqual(new Set([aliceRun]));
    expect(new Set(recordsOf(bob).map((record) => record.resource))).toEqual(new Set([bobRun]));
    expect(recordsOf(alice).map((record) => record.type)).toEqual(
      expect.arrayContaining(['run.completed', 'tool.started', 'tool.settled']),
    );
    const byRun = await rpc(opened.handler, 'bureau.audit.query', { runId: bobRun }, 'alice-key');
    expect(recordsOf(byRun)).toEqual([]);
  });

  it('lets bureau.audit:read see every owner’s records, and no other scope does', async () => {
    const { opened, aliceRun, bobRun } = await seed();

    for (const key of ['audit-reader-key', 'operator-key']) {
      const all = await rpc(opened.handler, 'bureau.audit.query', {}, key);
      const resources = new Set(recordsOf(all).map((record) => record.resource));
      expect([key, resources.has(aliceRun), resources.has(bobRun)]).toEqual([key, true, true]);
    }
    for (const key of ['tasks-operator-key', 'schedules-reader-key', 'workflows-reader-key']) {
      const none = await rpc(opened.handler, 'bureau.audit.query', {}, key);
      expect([key, recordsOf(none)]).toEqual([key, []]);
    }
  });
});

describe('what a record carries', () => {
  it('has no secret, transcript, tool argument, or memory content, for the owner or the operator', async () => {
    const { opened } = await seed();
    // The sentinels reach the audit trail itself; the operation is what keeps them out.
    const stored = JSON.stringify(
      await opened.bureau.internals.auditTrail?.query({ limit: 10_000 }),
    );
    for (const sentinel of [ARGUMENT, ANSWER, SECRET, MEMORY]) {
      expect(stored, sentinel).toContain(sentinel);
    }

    for (const key of ['alice-key', 'audit-reader-key', 'operator-key']) {
      const body = JSON.stringify(
        await rpc(opened.handler, 'bureau.audit.query', { limit: 100 }, key),
      );
      for (const sentinel of [ARGUMENT, TRANSCRIPT, ANSWER, SECRET, MEMORY]) {
        expect([key, sentinel, body.includes(sentinel)]).toEqual([key, sentinel, false]);
      }
    }
    const operator = await rpc(
      opened.handler,
      'bureau.audit.query',
      { limit: 100 },
      'operator-key',
    );
    expect(recordsOf(operator).map((record) => record.type)).toEqual(
      expect.arrayContaining(['credential.rotated', 'memory.write', 'tool.started']),
    );
  });

  it('is metadata: when, what kind, about which resource, by which actor, and a few scalar fields', async () => {
    const { opened } = await seed();

    const operator = await rpc(
      opened.handler,
      'bureau.audit.query',
      { limit: 100 },
      'operator-key',
    );

    for (const record of recordsOf(operator)) {
      expect(Object.keys(record).toSorted()).toEqual(
        ['detail', 'principal', 'resource', 'sequence', 'timestamp', 'type'].toSorted(),
      );
      for (const value of Object.values(record.detail ?? {})) {
        expect(['string', 'number', 'boolean']).toContain(typeof value);
      }
    }
    const rotated = recordsOf(operator).find((record) => record.type === 'credential.rotated');
    expect(rotated).toMatchObject({ principal: 'system:test', detail: null });
  });
});

describe('a record about a resource with no owner', () => {
  it('is read only through bureau.audit:read, and is hidden from every other caller', async () => {
    const { opened } = await seed();
    // The run it names is not one this Bureau holds, so the record has no owner to belong to.
    await opened.bureau.internals.auditTrail?.record({
      runId: 'run-that-is-gone',
      type: 'run.completed',
      detail: { finishReason: 'stop' },
    });

    for (const key of ['alice-key', 'bob-key', 'tasks-operator-key']) {
      const body = await rpc(opened.handler, 'bureau.audit.query', { limit: 100 }, key);
      const resources = recordsOf(body).map((record) => record.resource);
      expect([key, resources.includes('run-that-is-gone')]).toEqual([key, false]);
    }
    for (const key of ['audit-reader-key', 'operator-key']) {
      const body = await rpc(opened.handler, 'bureau.audit.query', { limit: 100 }, key);
      const resources = recordsOf(body).map((record) => record.resource);
      expect([key, resources.includes('run-that-is-gone')]).toEqual([key, true]);
    }
  });
});

describe('filters and paging', () => {
  it('narrows by type, by run, and by time', async () => {
    const { opened, aliceRun } = await seed();

    const typed = await rpc(
      opened.handler,
      'bureau.audit.query',
      { type: 'tool.started' },
      'alice-key',
    );
    expect(recordsOf(typed).map((record) => record.type)).toEqual(['tool.started']);
    const byRun = await rpc(opened.handler, 'bureau.audit.query', { runId: aliceRun }, 'alice-key');
    expect(new Set(recordsOf(byRun).map((record) => record.resource))).toEqual(new Set([aliceRun]));
    const future = await rpc(
      opened.handler,
      'bureau.audit.query',
      { since: Date.now() + 3_600_000 },
      'alice-key',
    );
    expect(recordsOf(future)).toEqual([]);
  });

  it('pages in order across an owner filter that drops rows, losing and repeating none', async () => {
    const opened = await openBureau();
    cleanups.push(() => opened.dispose());
    const trail = opened.bureau.internals.auditTrail!;
    const alice = await opened.bureau.schedules.create({
      agentName: 'default',
      spec: '1h',
      input: 'tick',
      principal: OWNER.alice,
    });
    const bob = await opened.bureau.schedules.create({
      agentName: 'default',
      spec: '1h',
      input: 'tick',
      principal: OWNER.bob,
    });
    // Interleaved, with Bob's rows between and after Alice's, so each page of Alice's must
    // skip rows it is not shown.
    const order = ['a', 'b', 'b', 'a', 'b', 'a', 'a', 'b', 'b', 'b', 'a', 'a', 'b', 'a'];
    for (const [index, who] of order.entries()) {
      await trail.record({
        runId: `schedule:${who === 'a' ? alice!.id : bob!.id}`,
        type: 'schedule.note',
        detail: { index },
      });
    }

    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await rpc(
        opened.handler,
        'bureau.audit.query',
        { type: 'schedule.note', limit: 3, ...(cursor === undefined ? {} : { cursor }) },
        'alice-key',
      );
      expect(page.error).toBeUndefined();
      expect(recordsOf(page).length).toBeLessThanOrEqual(3);
      for (const record of recordsOf(page)) {
        expect(record.resource).toBe(`schedule:${alice!.id}`);
        seen.push(record.sequence!);
      }
      cursor = (page.result!['nextCursor'] as string | null) ?? undefined;
      pages += 1;
    } while (cursor !== undefined && pages < 20);

    expect(seen).toHaveLength(order.filter((who) => who === 'a').length);
    expect(seen).toEqual(seen.toSorted((left, right) => left - right));
    expect(new Set(seen).size).toBe(seen.length);
    expect(pages).toBe(Math.ceil(seen.length / 3));
  });

  it('answers a cursor that is not one as InvalidParams', async () => {
    const opened = await openBureau();
    cleanups.push(() => opened.dispose());

    const bad = await rpc(
      opened.handler,
      'bureau.audit.query',
      { cursor: 'nonsense' },
      'alice-key',
    );

    expect(bad.error?.data?.httpStatus).toBe(400);
  });
});

describe('bureau.audit.query in process (COR-1705)', () => {
  it('returns the records the operator reads over the wire, for the same filter', async () => {
    const { opened } = await seed();

    for (const filter of [{}, { type: 'tool.started' }, { limit: 3 }]) {
      const wire = await rpc(opened.handler, 'bureau.audit.query', filter, 'operator-key');
      const inProcess = await opened.bureau.audit.query(filter);

      expect(wire.error).toBeUndefined();
      expect(inProcess.records.length).toBeGreaterThan(0);
      expect(wire.result).toEqual(JSON.parse(JSON.stringify(inProcess)));
    }
  });

  it('returns the records an owner reads over the wire when it is given that owner', async () => {
    const { opened, aliceRun } = await seed();

    const wire = await rpc(opened.handler, 'bureau.audit.query', { limit: 2 }, 'alice-key');
    const inProcess = await opened.bureau.audit.query({ limit: 2 }, { owner: OWNER.alice });

    expect(inProcess.records.length).toBe(2);
    expect(new Set(inProcess.records.map((record) => record.resource))).toEqual(
      new Set([aliceRun]),
    );
    expect(wire.result).toEqual(JSON.parse(JSON.stringify(inProcess)));
  });

  it('applies the same redaction as the wire, so no secret or content leaves it either', async () => {
    const { opened } = await seed();

    const page = await opened.bureau.audit.query({ limit: 100 });

    const serialized = JSON.stringify(page);
    for (const sentinel of [ARGUMENT, TRANSCRIPT, ANSWER, SECRET, MEMORY]) {
      expect([sentinel, serialized.includes(sentinel)]).toEqual([sentinel, false]);
    }
    expect(page.records.map((record) => record.type)).toEqual(
      expect.arrayContaining(['credential.rotated', 'memory.write']),
    );
  });

  it('hides a record with no owner from an owner, and shows it to the host', async () => {
    const { opened } = await seed();
    await opened.bureau.internals.auditTrail?.record({
      runId: 'run-that-is-gone',
      type: 'run.completed',
      detail: { finishReason: 'stop' },
    });

    const owned = await opened.bureau.audit.query({ limit: 100 }, { owner: OWNER.alice });
    const host = await opened.bureau.audit.query({ limit: 100 });

    expect(owned.records.map((record) => record.resource)).not.toContain('run-that-is-gone');
    expect(host.records.map((record) => record.resource)).toContain('run-that-is-gone');
  });

  it('refuses a cursor it did not issue and a filter outside the operation’s bounds as BAD_REQUEST', async () => {
    const opened = await openBureau();
    cleanups.push(() => opened.dispose());

    for (const filter of [
      { cursor: 'nonsense' },
      { limit: 0 },
      { limit: 101 },
      { since: -1 },
      { runId: '' },
      { type: '' },
    ]) {
      const refusal = await opened.bureau.audit.query(filter).catch((error: unknown) => error);
      expect([filter, (refusal as { code?: string }).code]).toEqual([filter, 'BAD_REQUEST']);
    }
  });
});

describe('a Bureau that keeps no audit trail', () => {
  it('refuses bureau.audit.query as UNSUPPORTED_CAPABILITY', async () => {
    const bare = await createBureau({ agents: {} });
    cleanups.push(() => bare.dispose());
    expect(bare.internals.auditTrail).toBeUndefined();

    const refusal = await bare.audit.query().catch((error: unknown) => error);

    expect((refusal as { code?: string }).code).toBe('UNSUPPORTED_CAPABILITY');
  });
});
