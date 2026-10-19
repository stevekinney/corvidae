/**
 * COR-1482 — `bureau.goals.*` over a real Bureau and its handler: each operation, the owner
 * predicate and the operator scopes (read and write apart), `expectedRevision` on cancel, and
 * what a goal's view leaves out.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { BUREAU_HANDLER_OPERATIONS, createBureauHandler } from '../create-bureau-handler.ts';
import {
  CHECK,
  createCheckValidator,
  goalRequest,
  hangUntilAborted,
  workerAgent,
} from '../../testing/goal-fixtures.test-support';
import {
  as,
  authentication,
  openBureau,
  type OpenedBureau,
  OWNER,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';
import { bureauGoalsOperations } from './goals-operations.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function serve(): Promise<OpenedBureau> {
  const opened = await openBureau({
    agents: { worker: workerAgent(hangUntilAborted) },
    generate: hangUntilAborted,
    validators: [createCheckValidator()],
  });
  cleanups.push(() => opened.dispose());
  return opened;
}

const SECRET_PROMPT = 'PROMPT-SENTINEL-93ab';

const NEW_GOAL = {
  agentName: 'worker',
  prompt: SECRET_PROMPT,
  instructions: 'INSTRUCTIONS-SENTINEL-5e0c',
  identity: { name: 'goal', version: '1' },
  validator: CHECK,
  bounds: { maximumAttempts: 3, maximumTotalSteps: 100 },
};

const status = (body: RpcBody) => body.error?.data?.httpStatus;

/** Creates a goal as `key` under an idempotency key, and answers the body; the goal's id is in it. */
async function createdBy(opened: OpenedBureau, key: string, idempotencyKey: string) {
  const body = await rpc(
    opened.handler,
    'bureau.goals.create',
    { ...NEW_GOAL, idempotencyKey },
    key,
  );
  expect(body.error).toBeUndefined();
  return body;
}

const idOf = (body: RpcBody) => (body.result!['goal'] as { goalRunId: string }).goalRunId;

describe('the operations list', () => {
  it('serves the four goal operations, registered and listed in OpenRPC', async () => {
    const names = [
      'bureau.goals.list',
      'bureau.goals.get',
      'bureau.goals.create',
      'bureau.goals.cancel',
    ];
    expect(bureauGoalsOperations.map((operation) => operation.name)).toEqual(names);
    for (const operation of bureauGoalsOperations) {
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

describe('each goal operation, as the owner', () => {
  it('creates a goal owned by the caller, and a repeat of the same request is the same goal', async () => {
    const opened = await serve();
    const first = await createdBy(opened, 'alice-key', 'alice-goal');
    expect(first.result).toMatchObject({
      outcome: 'created',
      goal: {
        owner: OWNER.alice,
        agentName: 'worker',
        revision: expect.any(Number),
        attempts: expect.any(Array),
        cancellation: null,
      },
    });
    const gAlice = idOf(first);

    const again = await createdBy(opened, 'alice-key', 'alice-goal');
    expect(again.result).toMatchObject({ outcome: 'existing', goal: { goalRunId: gAlice } });

    const other = await rpc(
      opened.handler,
      'bureau.goals.create',
      { ...NEW_GOAL, idempotencyKey: 'alice-goal', prompt: 'something else' },
      'alice-key',
    );
    expect(status(other)).toBe(409);
  });

  it('derives the goal’s id from the key and the caller, so one owner’s key never meets another’s goal', async () => {
    const opened = await serve();
    const alice = idOf(await createdBy(opened, 'alice-key', 'shared-key'));
    const bob = await createdBy(opened, 'bob-key', 'shared-key');

    expect(bob.result).toMatchObject({ outcome: 'created' });
    expect(idOf(bob)).not.toBe(alice);
  });

  it('reads and lists it, and leaves its prompt and instructions out of every view', async () => {
    const opened = await serve();
    const gAlice = idOf(await createdBy(opened, 'alice-key', 'alice-goal'));

    const read = await rpc(opened.handler, 'bureau.goals.get', { goalRunId: gAlice }, 'alice-key');
    expect(read.result).toMatchObject({ goalRunId: gAlice, owner: OWNER.alice });
    const listed = await rpc(opened.handler, 'bureau.goals.list', {}, 'alice-key');
    expect(
      (listed.result!['goals'] as Array<{ goalRunId: string }>).map((goal) => goal.goalRunId),
    ).toEqual([gAlice]);
    const filtered = await rpc(
      opened.handler,
      'bureau.goals.list',
      { status: 'succeeded' },
      'alice-key',
    );
    expect(filtered.result!['goals']).toEqual([]);
    for (const body of [read, listed]) {
      expect(JSON.stringify(body)).not.toContain(SECRET_PROMPT);
      expect(JSON.stringify(body)).not.toContain('INSTRUCTIONS-SENTINEL-5e0c');
    }
  });

  it('cancels it, answering the receipt with the revision after', async () => {
    const opened = await serve();
    const gAlice = idOf(await createdBy(opened, 'alice-key', 'alice-goal'));

    const canceled = await rpc(
      opened.handler,
      'bureau.goals.cancel',
      { goalRunId: gAlice, reason: 'no longer wanted' },
      'alice-key',
    );
    expect(['canceled', 'cancellation-pending']).toContain(canceled.result!['outcome'] as string);
    expect(canceled.result).toMatchObject({ goalRunId: gAlice, revision: expect.any(Number) });
    const read = await rpc(opened.handler, 'bureau.goals.get', { goalRunId: gAlice }, 'alice-key');
    expect(read.result).toMatchObject({ cancellation: { reason: 'no longer wanted' } });
  });

  it('answers a goal the Bureau refuses as the typed fault', async () => {
    const opened = await serve();
    const call = (extra: object) =>
      rpc(opened.handler, 'bureau.goals.create', { ...NEW_GOAL, ...extra }, 'alice-key');

    expect(status(await call({ agentName: 'nobody' }))).toBe(404);
    expect(status(await call({ validator: { name: 'absent', version: '1' } }))).toBe(422);
    expect(status(await call({ bounds: { maximumAttempts: 0 } }))).toBe(400);
    expect(status(await call({ conversationPolicy: { kind: 'fresh-from-artifact' } }))).toBe(400);
    const none = await rpc(opened.handler, 'bureau.goals.list', {}, 'alice-key');
    expect(none.result!['goals']).toEqual([]);
  });
});

describe('the owner predicate and the operator scopes', () => {
  it('shows a goal only to its owner and to bureau.goals:read, and answers anyone else as a missing one', async () => {
    const opened = await serve();
    const gAlice = idOf(await createdBy(opened, 'alice-key', 'alice-goal'));
    const missing = await rpc(
      opened.handler,
      'bureau.goals.get',
      { goalRunId: 'g-nobody' },
      'bob-key',
    );

    const denied = await rpc(opened.handler, 'bureau.goals.get', { goalRunId: gAlice }, 'bob-key');
    expect(status(denied)).toBe(404);
    expect(denied.error?.message?.replaceAll(gAlice, '<id>')).toBe(
      missing.error?.message?.replaceAll('g-nobody', '<id>'),
    );
    const awaited5 = await rpc(opened.handler, 'bureau.goals.list', {}, 'bob-key');
    expect(awaited5.result!['goals']).toEqual([]);

    for (const key of ['goals-reader-key', 'operator-key']) {
      const read = await rpc(opened.handler, 'bureau.goals.get', { goalRunId: gAlice }, key);
      expect(read.result).toMatchObject({ goalRunId: gAlice, owner: OWNER.alice });
      const listed = await rpc(opened.handler, 'bureau.goals.list', {}, key);
      expect(
        (listed.result!['goals'] as Array<{ goalRunId: string }>).map((goal) => goal.goalRunId),
      ).toEqual([gAlice]);
    }
    // A write scope does not imply the read scope.
    expect(
      status(
        await rpc(opened.handler, 'bureau.goals.get', { goalRunId: gAlice }, 'goals-writer-key'),
      ),
    ).toBe(404);
  });

  it('lets another principal cancel a goal only with bureau.goals:write', async () => {
    const opened = await serve();
    const gAlice = idOf(await createdBy(opened, 'alice-key', 'alice-goal'));

    for (const key of ['bob-key', 'goals-reader-key']) {
      const denied = await rpc(opened.handler, 'bureau.goals.cancel', { goalRunId: gAlice }, key);
      expect([key, status(denied)]).toEqual([key, 404]);
    }
    const untouched = await rpc(
      opened.handler,
      'bureau.goals.get',
      { goalRunId: gAlice },
      'alice-key',
    );
    expect(untouched.result).toMatchObject({ cancellation: null });

    const canceled = await rpc(
      opened.handler,
      'bureau.goals.cancel',
      { goalRunId: gAlice },
      'goals-writer-key',
    );
    expect(['canceled', 'cancellation-pending']).toContain(canceled.result!['outcome'] as string);
  });
});

describe('expectedRevision on cancel', () => {
  it('answers StaleRevision for another revision, writing nothing, and cancels at the current one', async () => {
    const opened = await serve();
    const created = await createdBy(opened, 'alice-key', 'alice-goal');
    const gAlice = idOf(created);
    const revision = (created.result!['goal'] as { revision: number }).revision;

    const stale = await rpc(
      opened.handler,
      'bureau.goals.cancel',
      { goalRunId: gAlice, expectedRevision: revision + 1 },
      'alice-key',
    );
    expect(status(stale)).toBe(409);
    const staleData = stale.error?.data as { currentRevision: number };
    expect(typeof staleData.currentRevision).toBe('number');
    expect(stale.error?.data).toMatchObject({ expectedRevision: revision + 1 });
    const untouched = await rpc(
      opened.handler,
      'bureau.goals.get',
      { goalRunId: gAlice },
      'alice-key',
    );
    expect(untouched.result).toMatchObject({ cancellation: null });

    const canceled = await rpc(
      opened.handler,
      'bureau.goals.cancel',
      { goalRunId: gAlice, expectedRevision: staleData.currentRevision },
      'alice-key',
    );
    expect(canceled.error).toBeUndefined();
  });
});

describe('a goal that another principal owns', () => {
  it('is read by its owner, whoever made it, and by no one else', async () => {
    const opened = await serve();
    await opened.bureau.goals.create(
      goalRequest({ goalRunId: 'g-made-directly', principal: OWNER.bob }),
    );

    const read = await rpc(
      opened.handler,
      'bureau.goals.get',
      { goalRunId: 'g-made-directly' },
      'bob-key',
    );
    expect(read.result).toMatchObject({ owner: OWNER.bob });
    expect(
      status(
        await rpc(
          opened.handler,
          'bureau.goals.get',
          { goalRunId: 'g-made-directly' },
          'alice-key',
        ),
      ),
    ).toBe(404);
  });
});

describe('the controller of a goal that was created', () => {
  it('is reported as started for a goal whose controller runs', async () => {
    const opened = await serve();

    const created = await createdBy(opened, 'alice-key', 'alice-goal');

    expect(created.result).toMatchObject({ controller: { status: 'started', reason: null } });
    const again = await createdBy(opened, 'alice-key', 'alice-goal');
    expect(again.result!['outcome']).toBe('existing');
  });

  it('is reported as start-failed, with why, so a goal that will never run does not read as pending forever', async () => {
    const opened = await serve();
    const failing = new Proxy(opened.bureau, {
      get(target, key) {
        if (key !== 'goals') return Reflect.get(target, key, target) as unknown;
        return {
          ...target.goals,
          create: async (request: Parameters<typeof target.goals.create>[0]) => {
            const outcome = await target.goals.create(request);
            return outcome.outcome === 'created'
              ? {
                  ...outcome,
                  controller: { status: 'start-failed' as const, reason: 'engine down' },
                }
              : outcome;
          },
        };
      },
    });
    const handler = createBureauHandler(failing, { authentication });

    const created = await rpc(
      handler,
      'bureau.goals.create',
      { ...NEW_GOAL, idempotencyKey: 'failing' },
      'alice-key',
    );

    expect(created.error).toBeUndefined();
    expect(created.result).toMatchObject({
      outcome: 'created',
      goal: { status: 'pending' },
      controller: { status: 'start-failed', reason: 'engine down' },
    });
  });
});
