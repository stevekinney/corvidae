/**
 * COR-1482 — `bureau.goals.*` over a real Bureau and its handler: each operation, the owner
 * predicate and the operator scopes (read and write apart), `expectedRevision` on cancel, and
 * what a goal's view leaves out.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { workspaceConformanceLedger } from '../workspace-conformance-ledger.test-support.ts';

import { BUREAU_HANDLER_OPERATIONS, createBureauHandler } from '../create-bureau-handler.ts';
import {
  CHECK,
  createCheckValidator,
  goalRequest,
  hangUntilAborted,
  pollUntil,
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
import {
  WORKSPACE_PRIVACY_ACTORS,
  openWorkspacePrivacyBureau,
  workspacePrivacyCall,
  type WorkspacePrivacyActor,
  workspaceAdministratorDirectory,
} from '../workspace-privacy-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function serve(): Promise<OpenedBureau> {
  const opened = await openBureau({
    agents: { worker: workerAgent(hangUntilAborted) },
    // A key with no scope sets goals only for an agent that opts into A2A (COR-1904).
    a2aAgents: ['worker'],
    generate: hangUntilAborted,
    validators: [createCheckValidator()],
  });
  cleanups.push(() => opened.dispose());
  return opened;
}

async function serveWorkspace(): Promise<OpenedBureau> {
  const opened = await openBureau({
    agents: { worker: workerAgent(hangUntilAborted) },
    a2aAgents: ['worker'],
    generate: hangUntilAborted,
    validators: [createCheckValidator()],
    handlerOptions: {
      workspace: workspaceAdministratorDirectory(),
    },
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

/** The revision a `StaleRevision` fault names as current, when `body` carries one. */
function currentRevisionOf(body: { error?: { data?: unknown } } | undefined): number | undefined {
  const data = body?.error?.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const current = (data as Record<string, unknown>)['currentRevision'];
  return typeof current === 'number' ? current : undefined;
}

/**
 * Changes a goal as `key` against the revision it is at when the call is sent. The goal's controller
 * can commit a transition between the read and the write, which the call answers `StaleRevision`
 * with the revision now current, having written nothing; it is then sent again at that revision.
 */
async function updateAtCurrentRevision(
  opened: OpenedBureau,
  key: string,
  goalRunId: string,
  change: Record<string, unknown>,
): Promise<RpcBody> {
  let expectedRevision = (await opened.bureau.goals.get(goalRunId))!.revision;
  for (;;) {
    const body = await rpc(
      opened.handler,
      'bureau.goals.update',
      { goalRunId, expectedRevision, ...change },
      key,
    );
    const current = currentRevisionOf(body);
    if (current === undefined) return body;
    expectedRevision = current;
  }
}

describe('the operations list', () => {
  it('serves the five goal operations, registered and listed in OpenRPC', async () => {
    const names = [
      'bureau.goals.list',
      'bureau.goals.get',
      'bureau.goals.create',
      'bureau.goals.cancel',
      'bureau.goals.update',
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

  it('names the goal and its check in every view, so a list can title it', async () => {
    const opened = await serve();
    const gAlice = idOf(await createdBy(opened, 'alice-key', 'alice-goal'));
    const named = {
      identity: NEW_GOAL.identity,
      validator: { name: CHECK.name, version: CHECK.version },
    };

    const read = await rpc(opened.handler, 'bureau.goals.get', { goalRunId: gAlice }, 'alice-key');
    expect(read.result).toMatchObject(named);
    const listed = await rpc(opened.handler, 'bureau.goals.list', {}, 'alice-key');
    expect((listed.result!['goals'] as Array<Record<string, unknown>>)[0]).toMatchObject(named);
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
  it('keeps a workspace administrator’s legacy goal scope owner-scoped', async () => {
    const opened = await serveWorkspace();
    const own = idOf(await createdBy(opened, 'operator-key', 'operator-goal'));
    const foreign = idOf(await createdBy(opened, 'alice-key', 'alice-goal'));
    const listed = await rpc(opened.handler, 'bureau.goals.list', {}, 'operator-key');
    expect(
      (listed.result!['goals'] as Array<{ goalRunId: string }>).map((goal) => goal.goalRunId),
    ).toEqual([own]);
    const foreignGet = await rpc(
      opened.handler,
      'bureau.goals.get',
      { goalRunId: foreign },
      'operator-key',
    );
    const unknownGet = await rpc(
      opened.handler,
      'bureau.goals.get',
      { goalRunId: 'goal-missing' },
      'operator-key',
    );
    expect(JSON.stringify(foreignGet).replaceAll(foreign, '<id>')).toBe(
      JSON.stringify(unknownGet).replaceAll('goal-missing', '<id>'),
    );
  });

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

describe('bureau.goals.update', () => {
  const NEW_PROMPT = 'PROMPT-UPDATE-SENTINEL-71c0';

  /** A goal of alice's whose first attempt is in flight. */
  async function runningGoalOfAlice(opened: OpenedBureau): Promise<string> {
    const goalRunId = idOf(await createdBy(opened, 'alice-key', 'alice-goal'));
    await pollUntil(async () => (await opened.bureau.goals.get(goalRunId))?.status === 'running');
    return goalRunId;
  }

  it('changes the owner’s goal for its future attempts, and answers a receipt that leaves the change out', async () => {
    const opened = await serve();
    const gAlice = await runningGoalOfAlice(opened);

    const updated = await updateAtCurrentRevision(opened, 'alice-key', gAlice, {
      prompt: NEW_PROMPT,
      maximumAttempts: 5,
    });

    expect(updated.error).toBeUndefined();
    expect(updated.result).toEqual({
      goalRunId: gAlice,
      outcome: 'updated',
      status: 'running',
      revision: expect.any(Number),
    });
    const stored = await opened.bureau.goals.get(gAlice);
    expect(stored?.objective.prompt).toBe(NEW_PROMPT);
    expect(stored?.bounds.maximumAttempts).toBe(5);
    expect(stored?.attempts).toHaveLength(1);
    const read = await rpc(opened.handler, 'bureau.goals.get', { goalRunId: gAlice }, 'alice-key');
    expect(read.result).toMatchObject({ bounds: { maximumAttempts: 5 } });
    expect(JSON.stringify(read)).not.toContain(NEW_PROMPT);
  });

  it('answers StaleRevision for another revision, writing nothing', async () => {
    const opened = await serve();
    const gAlice = await runningGoalOfAlice(opened);
    const revision = (await opened.bureau.goals.get(gAlice))!.revision;

    const stale = await rpc(
      opened.handler,
      'bureau.goals.update',
      { goalRunId: gAlice, expectedRevision: revision + 1_000, prompt: NEW_PROMPT },
      'alice-key',
    );

    expect(status(stale)).toBe(409);
    expect(stale.error?.data).toMatchObject({
      expectedRevision: revision + 1_000,
      currentRevision: expect.any(Number),
    });
    expect((await opened.bureau.goals.get(gAlice))?.objective.prompt).toBe(SECRET_PROMPT);
  });

  it('answers what the goal rules refuse as the typed fault', async () => {
    const opened = await serve();
    const gAlice = await runningGoalOfAlice(opened);
    const call = (change: Record<string, unknown>) =>
      updateAtCurrentRevision(opened, 'alice-key', gAlice, change);

    expect(status(await call({}))).toBe(400);
    expect(status(await call({ maximumAttempts: 257 }))).toBe(400);
    expect(status(await call({ agentName: 'nobody' }))).toBe(404);
    expect(status(await call({ validator: { name: 'absent', version: '1' } }))).toBe(422);
    const tooLow = await call({ maximumAttempts: 1 });
    expect(status(tooLow)).toBe(409);
    expect(tooLow.error?.data).toMatchObject({ reason: 'attempt-limit-too-low' });
    expect((await opened.bureau.goals.get(gAlice))?.objective.prompt).toBe(SECRET_PROMPT);

    await opened.bureau.goals.cancel(gAlice);
    const ended = await call({ prompt: NEW_PROMPT });
    expect(status(ended)).toBe(409);
    expect(['terminal', 'cancellation-requested']).toContain(
      ended.error?.data?.['reason'] as string,
    );
  });

  it('lets another principal change a goal only with bureau.goals:write', async () => {
    const opened = await serve();
    const gAlice = await runningGoalOfAlice(opened);

    for (const key of ['bob-key', 'goals-reader-key']) {
      const denied = await updateAtCurrentRevision(opened, key, gAlice, { prompt: NEW_PROMPT });
      expect([key, status(denied)]).toEqual([key, 404]);
    }
    expect((await opened.bureau.goals.get(gAlice))?.objective.prompt).toBe(SECRET_PROMPT);

    const changed = await updateAtCurrentRevision(opened, 'goals-writer-key', gAlice, {
      prompt: NEW_PROMPT,
    });
    expect(changed.error).toBeUndefined();
    expect((await opened.bureau.goals.get(gAlice))?.objective.prompt).toBe(NEW_PROMPT);
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

const witnesses = workspaceConformanceLedger('management/goals-operations.test.ts');
describe('workspace privacy for goals', () => {
  it('keeps a private cancellation reason in the owners goal projections', async () => {
    const opened = await openWorkspacePrivacyBureau({
      agents: { worker: workerAgent(hangUntilAborted) },
      a2aAgents: ['worker'],
      generate: hangUntilAborted,
      validators: [createCheckValidator()],
    });
    cleanups.push(() => opened.dispose());
    const input = { ...NEW_GOAL, idempotencyKey: 'private-goal-projection' };
    const created = await workspacePrivacyCall(opened, 'owner', 'bureau.goals.create', input);
    const goal = created.body?.result?.['goal'] as { goalRunId?: string } | undefined;
    if (goal?.goalRunId === undefined) throw new Error('Expected a private goal');
    const sentinel = 'PRIVATE-GOAL-CANCELLATION-4f2a';
    const canceled = await workspacePrivacyCall(opened, 'owner', 'bureau.goals.cancel', {
      goalRunId: goal.goalRunId,
      reason: sentinel,
    });
    expect(canceled.body?.error).toBeUndefined();
    for (const actor of Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[]) {
      for (const operation of [
        'bureau.goals.get',
        'bureau.goals.list',
        'bureau.goals.create',
      ] as const) {
        const parameters =
          operation === 'bureau.goals.get'
            ? { goalRunId: goal.goalRunId }
            : operation === 'bureau.goals.create'
              ? input
              : {};
        const result = await workspacePrivacyCall(opened, actor, operation, parameters);
        witnesses.observePrivateProjection(operation, actor, result);
        if (actor === 'owner') expect(result.text).toContain(sentinel);
        else {
          expect(result.text).not.toContain(sentinel);
          if (actor === 'foreign' || actor === 'removed') expect(result.status).toBe(403);
          else if (operation === 'bureau.goals.get')
            expect(result.body?.error?.data?.httpStatus).toBe(404);
        }
      }
    }
  });
  it('keeps every private goal operation owner-scoped despite legacy scopes', async () => {
    const opened = await openWorkspacePrivacyBureau({
      agents: { worker: workerAgent(hangUntilAborted) },
      a2aAgents: ['worker'],
      generate: hangUntilAborted,
      validators: [createCheckValidator()],
    });
    cleanups.push(() => opened.dispose());
    const create = async (actor: WorkspacePrivacyActor, idempotencyKey: string) => {
      const body = await workspacePrivacyCall(opened, actor, 'bureau.goals.create', {
        ...NEW_GOAL,
        idempotencyKey,
      });
      expect(body.status, actor).toBe(200);
      const goal = body.body?.result?.['goal'];
      expect(goal).toBeDefined();
      if (goal === undefined || typeof goal !== 'object' || goal === null || !('goalRunId' in goal))
        throw new Error(`Expected a created goal, got ${JSON.stringify(body.body)}`);
      return String(goal.goalRunId);
    };
    const aliceGoal = await create('owner', 'workspace-alice-goal');
    const administratorGoal = await create('administrator', 'workspace-admin-goal');
    expect(administratorGoal).not.toBe(aliceGoal);

    for (const actor of [
      ...(Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[]).filter(
        (value) => value !== 'owner',
      ),
      'owner',
    ] as WorkspacePrivacyActor[]) {
      const denied = actor === 'foreign' || actor === 'removed';
      const expectedStatus = denied ? 403 : actor === 'owner' ? 200 : 404;
      for (const [method, given] of [
        ['bureau.goals.get', { goalRunId: aliceGoal }],
        ['bureau.goals.update', { goalRunId: aliceGoal, prompt: 'workspace-test' }],
        ['bureau.goals.cancel', { goalRunId: aliceGoal, reason: 'workspace-test' }],
      ] as const) {
        // COR-2017: an update names the revision the goal is at, read just before it is sent.
        let input: Record<string, unknown> =
          method === 'bureau.goals.update'
            ? { ...given, expectedRevision: (await opened.bureau.goals.get(aliceGoal))!.revision }
            : given;
        let response = await workspacePrivacyCall(opened, actor, method, input);
        // The goal's controller can commit a transition between that read and the update, which
        // answers StaleRevision with the revision now current and writes nothing.
        let current = currentRevisionOf(response.body);
        while (current !== undefined) {
          input = { ...input, expectedRevision: current };
          response = await workspacePrivacyCall(opened, actor, method, input);
          current = currentRevisionOf(response.body);
        }
        witnesses.observeWire(method, actor, response);
        expect(response.status, `${actor} ${method}`).toBe(denied ? 403 : 200);
        if (actor === 'owner') expect(response.body?.error).toBeUndefined();
        if (expectedStatus === 404) {
          expect(response.body?.error?.data?.httpStatus, `${actor} ${method}`).toBe(404);
          const unknown = await workspacePrivacyCall(opened, actor, method, {
            ...input,
            goalRunId: 'unknown-goal',
          });
          expect(JSON.stringify(response.body?.error).replaceAll(aliceGoal, '<id>')).toBe(
            JSON.stringify(unknown.body?.error).replaceAll('unknown-goal', '<id>'),
          );
        }
      }
      const listed = await workspacePrivacyCall(opened, actor, 'bureau.goals.list', {});
      witnesses.observeCollection('bureau.goals.list', actor, listed, aliceGoal);
      expect(listed.status, `${actor} list`).toBe(denied ? 403 : 200);
      const ids = ((listed.body?.result?.['goals'] ?? []) as Array<{ goalRunId: string }>).map(
        (goal) => goal.goalRunId,
      );
      expect(ids, actor).toEqual(
        actor === 'owner' ? [aliceGoal] : actor === 'administrator' ? [administratorGoal] : [],
      );
    }
  });
  it('creates private goals for every current member and refuses both invalid memberships', async () => {
    const opened = await openWorkspacePrivacyBureau({
      agents: { worker: workerAgent(hangUntilAborted) },
      a2aAgents: ['worker'],
      generate: hangUntilAborted,
      validators: [createCheckValidator()],
    });
    cleanups.push(() => opened.dispose());
    for (const actor of Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[]) {
      const result = await workspacePrivacyCall(opened, actor, 'bureau.goals.create', {
        ...NEW_GOAL,
        idempotencyKey: `workspace-create-${actor}`,
      });
      const goal = result.body?.result?.['goal'] as { owner?: unknown } | undefined;
      witnesses.observeCreated(
        'bureau.goals.create',
        actor,
        result,
        goal?.owner === WORKSPACE_PRIVACY_ACTORS[actor].owner,
      );
      if (actor === 'foreign' || actor === 'removed') expect(result.status).toBe(403);
      else {
        expect(result.body?.error).toBeUndefined();
        expect(result.body?.result?.['goal']).toMatchObject({
          owner: WORKSPACE_PRIVACY_ACTORS[actor].owner,
        });
      }
    }
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
    const handler = createBureauHandler(failing, { authentication, a2aAgents: ['worker'] });

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

it('the workspace operation inventory has six executed actor witnesses', () => {
  witnesses.verify();
});
