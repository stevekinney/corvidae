import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createDurableEventHistory } from '../durable-event-history';
import {
  createInteractiveSurfaces,
  INTERACTIVE_SURFACE_EVENT_KINDS,
  type InteractiveSurfaceTask,
} from './store';
import {
  type CreateInteractiveSurfaceCommand,
  INTERACTIVE_SURFACE_CONTRACT_VERSION,
  type InteractiveSurface,
  type InteractiveSurfaceActionRequest,
  type UpdateInteractiveSurfaceCommand,
} from './types';

const version = INTERACTIVE_SURFACE_CONTRACT_VERSION;
const OWNER = 'api-key:alice';
const TASK = 'agent-run-1';

const formSchema = {
  type: 'object',
  properties: { reason: { type: 'string', minLength: 1 } },
  required: ['reason'],
} as const;

function harness(
  tasks: Record<string, InteractiveSurfaceTask> = {
    [TASK]: { owner: OWNER, contextId: 'session-1' },
  },
  extra: Partial<Parameters<typeof createInteractiveSurfaces>[0]> = {},
) {
  const runtime = createManualRuntimeServices();
  const storage = new MemoryStorage();
  const history = createDurableEventHistory(storage, runtime);
  const table = new Map(Object.entries(tasks));
  const settledListeners = new Map<string, (status: 'completed' | 'failed' | 'canceled') => void>();
  const surfaces = createInteractiveSurfaces({
    storage,
    history,
    task: async (taskId) => table.get(taskId),
    now: () => runtime.clock.now(),
    watchTask: (taskId, listener) => settledListeners.set(taskId, listener),
    ...extra,
  });
  async function events(taskId = TASK) {
    const page = await history.page({ kind: 'run', id: taskId }, { limit: 100 });
    if (!('events' in page)) throw new Error('expected a page');
    return page.events;
  }
  function settle(taskId: string, status: 'completed' | 'failed' | 'canceled') {
    const task = table.get(taskId);
    if (task === undefined) throw new Error(`no task ${taskId}`);
    table.set(taskId, { ...task, settled: status });
    settledListeners.get(taskId)?.(status);
  }
  return { surfaces, events, settle, table, storage };
}

function createCommand(
  overrides: Partial<CreateInteractiveSurfaceCommand> = {},
): CreateInteractiveSurfaceCommand {
  return {
    type: 'surface.create',
    contractVersion: version,
    commandId: 'create-1',
    taskId: TASK,
    surfaceId: 'reason-form',
    summary: 'Why are you deploying?',
    representation: { kind: 'input-form', schema: formSchema },
    actions: [
      {
        name: 'submit',
        intent: 'submit',
        continuation: { type: 'signal', sessionId: 'session-1', signalName: 'reason' },
      },
    ],
    ...overrides,
  };
}

function updateCommand(
  overrides: Partial<UpdateInteractiveSurfaceCommand> = {},
): UpdateInteractiveSurfaceCommand {
  return {
    type: 'surface.update',
    contractVersion: version,
    commandId: 'update-1',
    taskId: TASK,
    surfaceId: 'reason-form',
    baseRevision: 1,
    data: { reason: 'scheduled' },
    ...overrides,
  };
}

function actionRequest(
  overrides: Partial<InteractiveSurfaceActionRequest> = {},
): InteractiveSurfaceActionRequest {
  return {
    type: 'surface.action',
    contractVersion: version,
    commandId: 'act-1',
    taskId: TASK,
    surfaceId: 'reason-form',
    revision: 1,
    action: 'submit',
    value: { reason: 'hotfix' },
    ...overrides,
  };
}

const snapshotQuery = {
  type: 'surface.snapshot',
  contractVersion: version,
  taskId: TASK,
  surfaceId: 'reason-form',
} as const;

async function snapshotOf(
  surfaces: ReturnType<typeof harness>['surfaces'],
  authorization = {},
): Promise<InteractiveSurface> {
  const receipt = await surfaces.snapshot(snapshotQuery, authorization);
  if (receipt.outcome !== 'found') throw new Error(`snapshot was ${receipt.outcome}`);
  return receipt.surface;
}

describe('creating a surface', () => {
  it('commits revision 1 to the task history and reads it back', async () => {
    const { surfaces, events } = harness();

    const receipt = await surfaces.create(createCommand());

    expect(receipt.outcome).toBe('accepted');
    const surface = await snapshotOf(surfaces);
    expect(surface).toMatchObject({
      contractVersion: version,
      surfaceId: 'reason-form',
      taskId: TASK,
      owner: OWNER,
      kind: 'input-form',
      revision: 1,
      componentRevision: 1,
      dataRevision: 1,
      state: 'open',
      liveness: 'live',
      closeResult: null,
    });
    const recorded = await events();
    expect(recorded.map((event) => event.kind)).toEqual([INTERACTIVE_SURFACE_EVENT_KINDS.created]);
    expect(surface.eventCursor).toBe(recorded[0]?.cursor ?? null);
  });

  it('replays an exact retry and rejects a reused command id with other content', async () => {
    const { surfaces, events } = harness();
    await surfaces.create(createCommand());

    const retry = await surfaces.create(createCommand());
    const reused = await surfaces.create(createCommand({ summary: 'Something else' }));
    const second = await surfaces.create(createCommand({ commandId: 'create-2' }));

    expect(retry).toMatchObject({ outcome: 'accepted', replayed: true });
    expect(reused).toMatchObject({ outcome: 'rejected', reason: 'conflict' });
    expect(second).toMatchObject({ outcome: 'rejected', reason: 'conflict' });
    expect(await events()).toHaveLength(1);
  });

  it('refuses malformed and untrusted content, committing nothing', async () => {
    const { surfaces, events } = harness();
    const cases: CreateInteractiveSurfaceCommand[] = [
      { ...createCommand(), contractVersion: 'bureau.interactive-surface.v2' as typeof version },
      { ...createCommand(), extra: true } as CreateInteractiveSurfaceCommand,
      createCommand({ summary: '   ' }),
      createCommand({ representation: { kind: 'input-form', schema: { type: 'string' } } }),
      createCommand({
        representation: { kind: 'input-form', schema: { type: 'object', minProperties: 'x' } },
      }),
      createCommand({
        representation: {
          kind: 'mcp-app',
          resourceUri: 'https://example.test/app.html',
          mimeType: 'text/html;profile=mcp-app',
          contentDigest: `sha256:${'0'.repeat(64)}`,
          instanceId: 'instance-1',
          csp: { connectDomains: [], resourceDomains: [] },
          permissions: {},
        },
      }),
      createCommand({
        actions: [
          {
            name: 'approve',
            intent: 'approve',
            continuation: { type: 'signal', sessionId: 's', signalName: 'x' },
          },
        ],
      }),
    ];

    const receipts = await Promise.all(cases.map((command) => surfaces.create(command)));

    expect(receipts.map((receipt) => receipt.outcome === 'rejected' && receipt.reason)).toEqual(
      cases.map(() => 'invalid'),
    );
    expect(await events()).toHaveLength(0);
  });

  it('refuses content over the payload cap', async () => {
    const runtime = createManualRuntimeServices();
    const storage = new MemoryStorage();
    const surfaces = createInteractiveSurfaces({
      storage,
      history: createDurableEventHistory(storage, runtime),
      task: async () => ({ owner: OWNER, contextId: 'session-1' }),
      now: () => runtime.clock.now(),
      maxPayloadBytes: 512,
    });

    const receipt = await surfaces.create(createCommand({ data: { padding: 'x'.repeat(600) } }));

    expect(receipt).toMatchObject({ outcome: 'rejected', reason: 'payload-too-large' });
  });

  it('accepts each representation kind with its own metadata intact', async () => {
    const { surfaces } = harness();
    const a2ui = await surfaces.create(
      createCommand({
        commandId: 'a2ui',
        surfaceId: 'a2ui',
        representation: {
          kind: 'a2ui',
          specificationVersion: 'v0.9.1',
          catalogId: 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json',
          components: [{ id: 'root', component: 'Text', text: 'Hello' }],
        },
        actions: [],
      }),
    );
    const app = await surfaces.create(
      createCommand({
        commandId: 'app',
        surfaceId: 'app',
        representation: {
          kind: 'mcp-app',
          resourceUri: 'ui://inspector/run',
          mimeType: 'text/html;profile=mcp-app',
          contentDigest: `sha256:${'a'.repeat(64)}`,
          instanceId: 'instance-1',
          csp: { connectDomains: ['https://api.example.test'], resourceDomains: [] },
          permissions: { clipboardWrite: true },
          toolName: 'inspect_run',
        },
        actions: [],
      }),
    );

    expect(a2ui.outcome === 'accepted' && a2ui.surface.representation).toMatchObject({
      kind: 'a2ui',
      specificationVersion: 'v0.9.1',
    });
    expect(app.outcome === 'accepted' && app.surface.representation).toMatchObject({
      kind: 'mcp-app',
      resourceUri: 'ui://inspector/run',
      csp: { connectDomains: ['https://api.example.test'], resourceDomains: [] },
      permissions: { clipboardWrite: true },
    });
  });
});

describe('updating a surface', () => {
  it('commits by compare-and-swap and tracks which part changed', async () => {
    const { surfaces } = harness();
    await surfaces.create(createCommand());

    const data = await surfaces.update(updateCommand());
    const form = await surfaces.update(
      updateCommand({
        commandId: 'update-2',
        baseRevision: 2,
        data: undefined,
        representation: { kind: 'input-form', schema: formSchema, submitLabel: 'Deploy' },
      }),
    );

    expect(data).toMatchObject({ outcome: 'accepted', surface: { revision: 2, dataRevision: 2 } });
    expect(form).toMatchObject({
      outcome: 'accepted',
      surface: { revision: 3, componentRevision: 3, dataRevision: 2 },
    });
  });

  it('rejects a stale update atomically and leaves the surface unchanged', async () => {
    const { surfaces, events } = harness();
    await surfaces.create(createCommand());
    await surfaces.update(updateCommand());
    const before = await snapshotOf(surfaces);

    const stale = await surfaces.update(
      updateCommand({ commandId: 'update-2', data: { reason: 'late' } }),
    );

    expect(stale).toMatchObject({
      outcome: 'rejected',
      reason: 'stale-revision',
      currentRevision: 2,
    });
    expect(await snapshotOf(surfaces)).toEqual(before);
    expect(await events()).toHaveLength(2);
  });

  it('lets exactly one of two concurrent updates from the same revision win', async () => {
    const { surfaces, events } = harness();
    await surfaces.create(createCommand());

    const [first, second] = await Promise.all([
      surfaces.update(updateCommand({ commandId: 'left', data: { reason: 'left' } })),
      surfaces.update(updateCommand({ commandId: 'right', data: { reason: 'right' } })),
    ]);

    const outcomes = [first, second].map((receipt) => receipt.outcome).toSorted();
    expect(outcomes).toEqual(['accepted', 'rejected']);
    const loser = first.outcome === 'rejected' ? first : second;
    expect(loser).toMatchObject({ reason: 'stale-revision', currentRevision: 2 });
    const winner = first.outcome === 'accepted' ? first : second;
    const read = await snapshotOf(surfaces);
    expect(read.data).toEqual(winner.outcome === 'accepted' ? winner.surface.data : null);
    const recorded = await events();
    expect(recorded.map((event) => event.kind)).toEqual([
      INTERACTIVE_SURFACE_EVENT_KINDS.created,
      INTERACTIVE_SURFACE_EVENT_KINDS.updated,
    ]);
  });

  it('refuses to change the representation kind', async () => {
    const { surfaces } = harness();
    await surfaces.create(createCommand());

    const receipt = await surfaces.update(
      updateCommand({
        data: undefined,
        representation: {
          kind: 'a2ui',
          specificationVersion: 'v0.9.1',
          catalogId: 'basic',
          components: [{ id: 'root', component: 'Text', text: 'x' }],
        },
      }),
    );

    expect(receipt).toMatchObject({ outcome: 'rejected', reason: 'invalid' });
  });
});

describe('ownership and audience', () => {
  it('hides a surface from a child, a sibling, and an unrelated principal', async () => {
    const { surfaces } = harness({
      [TASK]: { owner: OWNER, contextId: 'session-1' },
      'agent-run-sibling': { owner: OWNER, contextId: 'session-1' },
    });
    await surfaces.create(createCommand());

    const fromChild = await surfaces.snapshot(snapshotQuery, { taskId: 'child-run-1' });
    const fromSibling = await surfaces.update(updateCommand(), { taskId: 'agent-run-sibling' });
    const fromStranger = await surfaces.snapshot(snapshotQuery, { principal: 'api-key:mallory' });
    const strangerActs = await surfaces.act(actionRequest(), { principal: 'api-key:mallory' });
    const childCreates = await surfaces.create(createCommand({ commandId: 'c', surfaceId: 'x' }), {
      taskId: 'child-run-1',
    });

    for (const receipt of [fromChild, fromSibling, fromStranger, strangerActs, childCreates]) {
      expect(receipt).toMatchObject({ outcome: 'rejected', reason: 'not-found' });
    }
    const ownRead = await snapshotOf(surfaces, { principal: OWNER, taskId: TASK });
    expect(ownRead.revision).toBe(1);
  });

  it('lets the audience read and act, but not change the surface', async () => {
    const { surfaces } = harness();
    await surfaces.create(createCommand({ audience: ['api-key:bob'] }));
    const bob = { principal: 'api-key:bob' };

    const bobsRead = await snapshotOf(surfaces, bob);
    expect(bobsRead.audience).toEqual(['api-key:bob']);
    expect(await surfaces.act(actionRequest(), bob)).toMatchObject({ outcome: 'accepted' });
    expect(await surfaces.update(updateCommand(), bob)).toMatchObject({ reason: 'not-found' });
  });

  it('refuses an action from a stale MCP App instance', async () => {
    const { surfaces, events } = harness();
    await surfaces.create(
      createCommand({
        representation: {
          kind: 'mcp-app',
          resourceUri: 'ui://reviews/pending',
          mimeType: 'text/html;profile=mcp-app',
          contentDigest: `sha256:${'b'.repeat(64)}`,
          instanceId: 'instance-2',
          csp: { connectDomains: [], resourceDomains: [] },
          permissions: {},
        },
        actions: [
          {
            name: 'approve',
            intent: 'approve',
            continuation: { type: 'review', reviewId: 'approval:agent-run-1:call-1' },
          },
        ],
      }),
    );

    const stale = await surfaces.act(actionRequest({ action: 'approve', value: undefined }), {
      instanceId: 'instance-1',
    });
    const current = await surfaces.act(
      actionRequest({ commandId: 'act-2', action: 'approve', value: undefined }),
      { instanceId: 'instance-2' },
    );

    expect(stale).toMatchObject({ outcome: 'rejected', reason: 'stale-instance' });
    expect(current).toMatchObject({
      outcome: 'accepted',
      continuation: { type: 'review', reviewId: 'approval:agent-run-1:call-1' },
    });
    const recorded = await events();
    expect(recorded.filter((event) => event.kind.includes('action'))).toHaveLength(1);
  });
});

describe('action admission', () => {
  it('admits a valid action with its continuation and records it', async () => {
    const { surfaces, events } = harness();
    await surfaces.create(createCommand());

    const receipt = await surfaces.act(actionRequest());

    expect(receipt).toEqual({
      contractVersion: version,
      outcome: 'accepted',
      commandId: 'act-1',
      taskId: TASK,
      surfaceId: 'reason-form',
      revision: 1,
      action: 'submit',
      intent: 'submit',
      continuation: { type: 'signal', sessionId: 'session-1', signalName: 'reason' },
      value: { reason: 'hotfix' },
      replayed: false,
    });
    const recorded = await events();
    expect(recorded.at(-1)).toMatchObject({
      kind: INTERACTIVE_SURFACE_EVENT_KINDS.actionAdmitted,
      payload: { action: 'submit', value: { reason: 'hotfix' } },
    });
    expect(await surfaces.act(actionRequest())).toMatchObject({ replayed: true });
    expect(await events()).toHaveLength(2);
  });

  it('denies an unknown, stale, or invalid action and commits nothing', async () => {
    const { surfaces, events } = harness();
    await surfaces.create(createCommand());

    const unknown = await surfaces.act(actionRequest({ action: 'delete-everything' }));
    const stale = await surfaces.act(actionRequest({ commandId: 'a2', revision: 7 }));
    const invalid = await surfaces.act(actionRequest({ commandId: 'a3', value: { reason: '' } }));

    expect(unknown).toMatchObject({ outcome: 'rejected', reason: 'invalid' });
    expect(stale).toMatchObject({ outcome: 'rejected', reason: 'stale-revision' });
    expect(invalid).toMatchObject({ outcome: 'rejected', reason: 'invalid' });
    expect(await events()).toHaveLength(1);
  });

  it('records only the digest of a sensitive surface’s action value', async () => {
    const { surfaces, events } = harness();
    await surfaces.create(createCommand({ classification: 'sensitive' }));

    await surfaces.act(actionRequest({ value: { reason: 'my account number' } }));

    const recorded = await events();
    const payload = recorded.at(-1)?.payload as Record<string, unknown>;
    expect(payload['value']).toBeUndefined();
    expect(payload['valueDigest']).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('closing, cancellation, and cleanup', () => {
  it('tears a surface down on close and refuses later changes and actions', async () => {
    const { surfaces } = harness();
    await surfaces.create(createCommand());

    const closed = await surfaces.close({
      type: 'surface.close',
      contractVersion: version,
      commandId: 'close-1',
      taskId: TASK,
      surfaceId: 'reason-form',
      baseRevision: 1,
      reason: 'dismissed',
    });

    expect(closed).toMatchObject({
      outcome: 'accepted',
      surface: {
        state: 'closed',
        liveness: 'torn-down',
        representation: null,
        actions: [],
        closeResult: { reason: 'dismissed' },
      },
    });
    expect(await surfaces.act(actionRequest({ revision: 2 }))).toMatchObject({ reason: 'closed' });
    expect(await surfaces.update(updateCommand({ baseRevision: 2 }))).toMatchObject({
      reason: 'closed',
    });
  });

  it('freezes every surface on owner abort, keeps the last revision readable, and reports cleanup', async () => {
    const { surfaces } = harness();
    await surfaces.create(createCommand());
    await surfaces.create(createCommand({ commandId: 'create-2', surfaceId: 'second' }));
    await surfaces.update(updateCommand());

    const aborted = await surfaces.abort({
      type: 'surface.owner-abort',
      contractVersion: version,
      commandId: 'abort-1',
      taskId: TASK,
    });

    expect(aborted).toMatchObject({
      outcome: 'accepted',
      frozen: 2,
      cleanup: { status: 'completed' },
    });
    const frozen = await snapshotOf(surfaces);
    expect(frozen).toMatchObject({
      state: 'closed',
      liveness: 'frozen',
      closeResult: { reason: 'cancelled' },
      data: { reason: 'scheduled' },
      representation: { kind: 'input-form' },
    });
    expect(await surfaces.act(actionRequest({ revision: frozen.revision }))).toMatchObject({
      reason: 'closed',
    });
    expect(
      await surfaces.cleanup({ type: 'surface.cleanup', contractVersion: version, taskId: TASK }),
    ).toMatchObject({ outcome: 'found', cleanup: { status: 'completed' } });
  });

  it('freezes on the task’s cancellation and resolves the awaited cleanup evidence', async () => {
    const { surfaces, settle } = harness();
    await surfaces.create(createCommand());
    const evidence = surfaces.closed(TASK);

    expect(
      await surfaces.cleanup({ type: 'surface.cleanup', contractVersion: version, taskId: TASK }),
    ).toMatchObject({ outcome: 'pending', open: 1 });
    settle(TASK, 'canceled');

    expect(await evidence).toEqual({ status: 'completed' });
    expect(await snapshotOf(surfaces)).toMatchObject({
      liveness: 'frozen',
      closeResult: { reason: 'cancelled' },
    });
  });

  it('never admits an action on an ended task whose freeze cannot be written', async () => {
    const runtime = createManualRuntimeServices();
    const memory = new MemoryStorage();
    const writable = { value: true };
    const storage = new Proxy(memory, {
      get(target, property, receiver) {
        if (property === 'conditionalBatch' && !writable.value) return async () => false;
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const task: { current: InteractiveSurfaceTask } = {
      current: { owner: OWNER, contextId: 'session-1' },
    };
    const surfaces = createInteractiveSurfaces({
      storage,
      history: createDurableEventHistory(storage, runtime),
      task: async () => task.current,
      now: () => runtime.clock.now(),
    });
    await surfaces.create(createCommand());
    task.current = { owner: OWNER, contextId: 'session-1', settled: 'canceled' };
    writable.value = false;

    const outcome = await surfaces.act(actionRequest()).then(
      (receipt) => receipt.outcome,
      () => 'storage failure',
    );

    expect(outcome).not.toBe('accepted');
  });

  it('freezes a surface whose task ended unseen when it is next read', async () => {
    const { surfaces, table } = harness();
    await surfaces.create(createCommand());
    table.set(TASK, { owner: OWNER, contextId: 'session-1', settled: 'completed' });

    expect(await snapshotOf(surfaces)).toMatchObject({
      liveness: 'frozen',
      closeResult: { reason: 'task-ended' },
    });
    expect(
      await surfaces.create(createCommand({ commandId: 'late', surfaceId: 'late' })),
    ).toMatchObject({
      reason: 'closed',
    });
  });

  it('times a caller out of an unsettled wait, and needs no cleanup for a task with no surfaces', async () => {
    const { surfaces } = harness();
    expect(await surfaces.closed(TASK)).toEqual({ status: 'not-required' });
    await surfaces.create(createCommand());
    const controller = new AbortController();
    const waiting = surfaces.closed(TASK, { signal: controller.signal });
    controller.abort();

    expect(await waiting).toEqual({ status: 'unresolved', reason: 'timed-out' });
  });

  it('refuses a close made against an earlier revision', async () => {
    const { surfaces } = harness();
    await surfaces.create(createCommand());
    await surfaces.update(updateCommand());

    const stale = await surfaces.close({
      type: 'surface.close',
      contractVersion: version,
      commandId: 'close-stale',
      taskId: TASK,
      surfaceId: 'reason-form',
      baseRevision: 1,
      reason: 'completed',
    });

    expect(stale).toMatchObject({ outcome: 'rejected', reason: 'stale-revision' });
    expect(await snapshotOf(surfaces)).toMatchObject({ state: 'open', revision: 2 });
  });

  it('counts each surface once when two aborts race', async () => {
    const { surfaces } = harness();
    await surfaces.create(createCommand());
    await surfaces.create(createCommand({ commandId: 'create-2', surfaceId: 'second' }));
    const abort = (commandId: string) =>
      surfaces.abort({
        type: 'surface.owner-abort',
        contractVersion: version,
        commandId,
        taskId: TASK,
      });

    const receipts = await Promise.all([abort('abort-a'), abort('abort-b')]);

    let total = 0;
    for (const receipt of receipts) if ('frozen' in receipt) total += receipt.frozen;
    expect(total).toBe(2);
  });

  it('answers an exact retry of an abort by its effect, counting nothing it did not freeze', async () => {
    const { surfaces } = harness();
    await surfaces.create(createCommand());
    const command = {
      type: 'surface.owner-abort',
      contractVersion: version,
      commandId: 'abort-1',
      taskId: TASK,
    } as const;

    expect(await surfaces.abort(command)).toMatchObject({ outcome: 'accepted', frozen: 1 });
    expect(await surfaces.abort(command)).toMatchObject({
      outcome: 'accepted',
      frozen: 0,
      cleanup: { status: 'completed' },
    });
  });

  it('leaves nothing behind when a task is removed while a commit writes its cursor', async () => {
    for (let turns = 0; turns < 40; turns += 1) {
      const { surfaces, storage } = harness();
      await surfaces.create(createCommand());
      const updating = surfaces.update(updateCommand());
      for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
      await surfaces.removeTask(TASK);
      await updating;

      const left: string[] = [];
      for await (const key of storage.keys('')) if (key.includes('bureau-surface')) left.push(key);
      expect({ turns, left }).toEqual({ turns, left: [] });
    }
  });

  it('accepts a review of a session run whose id holds a colon, and refuses one of another run', async () => {
    const runId = 'session-1:0';
    const { surfaces } = harness({ [runId]: { owner: OWNER, contextId: 'session-1' } });
    const review = (reviewId: string, commandId: string) =>
      surfaces.create(
        createCommand({
          commandId,
          surfaceId: commandId,
          taskId: runId,
          actions: [
            {
              name: 'approve',
              intent: 'approve',
              continuation: { type: 'review', reviewId },
            },
          ],
        }),
      );

    expect(await review(`approval:${runId}:call-1`, 'own')).toMatchObject({ outcome: 'accepted' });
    expect(await review('approval:session-1:1:call-1', 'other')).toMatchObject({
      reason: 'invalid',
    });
  });

  it('refuses a nested $id, but not a property named $id', async () => {
    const { surfaces } = harness();
    const nested = await surfaces.create(
      createCommand({
        representation: {
          kind: 'input-form',
          schema: { type: 'object', properties: { value: { $id: 'nested', type: 'string' } } },
        },
      }),
    );
    const named = await surfaces.create(
      createCommand({
        commandId: 'create-2',
        surfaceId: 'named',
        representation: {
          kind: 'input-form',
          schema: { type: 'object', properties: { $id: { type: 'string' } } },
        },
      }),
    );

    expect(nested).toMatchObject({ reason: 'invalid' });
    expect(named).toMatchObject({ outcome: 'accepted' });
  });

  it('keeps a revision’s cursor when an action lands while it is being written', async () => {
    const { surfaces, storage } = harness();
    await surfaces.create(createCommand());
    // Hold the update's cursor write open until the action has committed.
    const action = Promise.withResolvers<void>();
    const get = storage.get.bind(storage);
    Reflect.set(storage, 'get', async (key: string) => {
      if (key.includes('cursor:')) await action.promise;
      return get(key);
    });
    const updating = surfaces.update(updateCommand());
    let admitted: unknown;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      admitted = await surfaces.act(actionRequest({ revision: 2 }));
      if ((admitted as { outcome?: string }).outcome === 'accepted') break;
      await Promise.resolve();
    }
    expect(admitted).toMatchObject({ outcome: 'accepted' });
    action.resolve();
    expect(await updating).toMatchObject({ outcome: 'accepted' });

    const surface = await snapshotOf(surfaces);
    expect(surface.eventCursor).not.toBeNull();
  });

  it('answers a command that keeps losing its commit with a contended rejection', async () => {
    const { surfaces, storage } = harness();
    await surfaces.create(createCommand());
    // Every read of the projection sees it changed again, and every commit fails.
    let reads = 0;
    const get = storage.get.bind(storage);
    Reflect.set(storage, 'get', async (key: string) => {
      const value = await get(key);
      if (value === null || !key.includes('surface:')) return value;
      reads += 1;
      return new TextEncoder().encode(`${new TextDecoder().decode(value)}${' '.repeat(reads)}`);
    });
    Reflect.set(storage, 'conditionalBatch', async () => false);

    expect(await surfaces.update(updateCommand())).toMatchObject({
      outcome: 'rejected',
      reason: 'contended',
    });
  });

  it('refuses an unpaired surrogate in an identifier and a backslash path in a CSP origin', async () => {
    const { surfaces } = harness();
    expect(await surfaces.create(createCommand({ surfaceId: '\ud800' }))).toMatchObject({
      reason: 'invalid',
    });
    expect(
      await surfaces.create(
        createCommand({
          commandId: 'create-2',
          surfaceId: 'app',
          actions: [],
          representation: {
            kind: 'mcp-app',
            resourceUri: 'ui://reviews/pending',
            mimeType: 'text/html;profile=mcp-app',
            contentDigest: `sha256:${'c'.repeat(64)}`,
            instanceId: 'instance-1',
            csp: { connectDomains: ['https://example.com\\evil'], resourceDomains: [] },
            permissions: {},
          },
        }),
      ),
    ).toMatchObject({ reason: 'invalid' });
  });

  it('keeps an A2UI surface’s sendDataModel flag', async () => {
    const { surfaces } = harness();
    const created = await surfaces.create(
      createCommand({
        actions: [],
        representation: {
          kind: 'a2ui',
          specificationVersion: 'v0.9.1',
          catalogId: 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json',
          components: [{ id: 'root', component: 'Text', text: 'Hello' }],
          sendDataModel: true,
        },
      }),
    );
    expect(created).toMatchObject({
      outcome: 'accepted',
      surface: { representation: { sendDataModel: true } },
    });
  });

  it('refuses a review that a longer task id owns, even when this task id prefixes it', async () => {
    const { surfaces } = harness({
      'session-1': { owner: OWNER, contextId: 'session-0' },
      'session-1:0': { owner: OWNER, contextId: 'session-1' },
    });
    const created = await surfaces.create(
      createCommand({
        taskId: 'session-1',
        actions: [
          {
            name: 'approve',
            intent: 'approve',
            continuation: { type: 'review', reviewId: 'approval:session-1:0:call-1' },
          },
        ],
      }),
    );
    expect(created).toMatchObject({ reason: 'invalid' });
  });

  it('records an A2UI action’s source component and timestamp', async () => {
    const { surfaces, events } = harness();
    await surfaces.create(createCommand());
    const admitted = await surfaces.act(
      actionRequest({ sourceComponentId: 'submit-button', timestamp: '2026-10-22T12:00:00.000Z' }),
    );
    expect(admitted).toMatchObject({ outcome: 'accepted' });
    const history = await events();
    const recorded = history.find(
      (event) => event.kind === INTERACTIVE_SURFACE_EVENT_KINDS.actionAdmitted,
    );
    expect(recorded?.payload).toMatchObject({
      sourceComponentId: 'submit-button',
      timestamp: '2026-10-22T12:00:00.000Z',
    });
    expect(
      await surfaces.act(actionRequest({ commandId: 'act-2', timestamp: 'yesterday' })),
    ).toMatchObject({ reason: 'invalid' });
  });

  it('refuses a review of a run whose session id holds a colon, from a task its id begins with', async () => {
    const { surfaces } = harness({ a: { owner: OWNER, contextId: 'a-session' } });
    const review = (reviewId: string, commandId: string) =>
      surfaces.create(
        createCommand({
          commandId,
          surfaceId: commandId,
          taskId: 'a',
          actions: [
            { name: 'approve', intent: 'approve', continuation: { type: 'review', reviewId } },
          ],
        }),
      );

    // `a:x:0` is a session run of session `a:x`; no task `a:x` exists to look up.
    expect(await review('approval:a:x:0:call', 'foreign')).toMatchObject({ reason: 'invalid' });
    expect(await review('human-wait:a:x:0:signal:1', 'foreign-wait')).toMatchObject({
      reason: 'invalid',
    });
    expect(await review('approval:a:call-1', 'own')).toMatchObject({ outcome: 'accepted' });
    expect(await review('human-wait:a:reason:0', 'own-wait')).toMatchObject({
      outcome: 'accepted',
    });
  });

  it('accepts an A2UI surface before its components arrive, and caps the audience', async () => {
    const { surfaces } = harness();
    expect(
      await surfaces.create(
        createCommand({
          actions: [],
          representation: {
            kind: 'a2ui',
            specificationVersion: 'v0.9.1',
            catalogId: 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json',
            components: [],
          },
        }),
      ),
    ).toMatchObject({ outcome: 'accepted' });

    const huge = Array.from(
      { length: 5000 },
      (_, index) => `principal-${index}-${'x'.repeat(200)}`,
    );
    expect(
      await surfaces.create(createCommand({ commandId: 'big', surfaceId: 'big', audience: huge })),
    ).toMatchObject({ reason: 'payload-too-large' });
    expect(
      await surfaces.create(
        createCommand({ commandId: 'long', surfaceId: 'long', audience: ['p'.repeat(300)] }),
      ),
    ).toMatchObject({ reason: 'invalid' });
  });

  it('decides review ownership from the reviews the task holds, when it is told them', async () => {
    const reviews = new Map([['agent-run-1', new Set(['human-wait:agent-run-1:approval:gate:0'])]]);
    const { surfaces } = harness(undefined, {
      reviewIdsOf: async (taskId) => reviews.get(taskId) ?? new Set(),
    });
    const review = (reviewId: string, commandId: string) =>
      surfaces.create(
        createCommand({
          commandId,
          surfaceId: commandId,
          actions: [
            { name: 'approve', intent: 'approve', continuation: { type: 'review', reviewId } },
          ],
        }),
      );

    // A signal name may hold a colon; the task's own pending wait is accepted.
    expect(await review('human-wait:agent-run-1:approval:gate:0', 'own')).toMatchObject({
      outcome: 'accepted',
    });
    // A well-formed id the task does not hold is refused.
    expect(await review('approval:agent-run-1:call-9', 'unheld')).toMatchObject({
      reason: 'invalid',
    });
  });

  it('refuses a create that lands after its task’s surfaces were removed', async () => {
    const { surfaces, storage } = harness();
    await surfaces.removeTask(TASK);
    expect(await surfaces.create(createCommand())).toMatchObject({ reason: 'not-found' });
    const left: string[] = [];
    for await (const key of storage.keys('bureau-surface:')) left.push(key);
    expect(left).toEqual([]);
  });

  it('refuses a calendar-invalid action timestamp, and accepts a components delta without root', async () => {
    const { surfaces } = harness();
    await surfaces.create(createCommand());
    expect(await surfaces.act(actionRequest({ timestamp: '2023-02-29T00:00:00Z' }))).toMatchObject({
      reason: 'invalid',
    });

    expect(
      await surfaces.create(
        createCommand({
          commandId: 'a2ui',
          surfaceId: 'a2ui',
          actions: [],
          representation: {
            kind: 'a2ui',
            specificationVersion: 'v0.9.1',
            catalogId: 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json',
            components: [{ id: 'title', component: 'Text', text: 'Before root' }],
          },
        }),
      ),
    ).toMatchObject({ outcome: 'accepted' });
  });

  it('lets a task id reused by a new incarnation create surfaces after the old one was removed', async () => {
    const { surfaces, table } = harness({
      [TASK]: { owner: OWNER, contextId: 'session-1', generation: 'one' },
    });
    await surfaces.create(createCommand());
    await surfaces.removeTask(TASK);
    expect(await surfaces.create(createCommand({ commandId: 'again' }))).toMatchObject({
      reason: 'not-found',
    });

    table.set(TASK, { owner: OWNER, contextId: 'session-1', generation: 'two' });
    expect(await surfaces.create(createCommand({ commandId: 'reborn' }))).toMatchObject({
      outcome: 'accepted',
    });
  });

  it('retires a removal marker once no command can still be in flight for that generation (COR-1638)', async () => {
    const runtime = createManualRuntimeServices();
    const storage = new MemoryStorage();
    const surfaces = createInteractiveSurfaces({
      storage,
      history: createDurableEventHistory(storage, runtime),
      task: async (taskId) => ({ owner: OWNER, contextId: 'session-1', generation: taskId }),
      now: () => runtime.clock.now(),
    });
    const text = textValueStore(storage, { disposeUnderlyingStorage: false });
    const markers = (): Promise<string[]> => text.list('bureau-removed-surfaces:v1:');

    // A task that never had a surface is marked too, and the marker is kept while it can matter.
    await surfaces.removeTask('task-a');
    await surfaces.removeTask('task-b');
    expect(await markers()).toHaveLength(2);

    // A day later the next removal retires the markers that are past the window and keeps its own.
    await runtime.advance(25 * 60 * 60 * 1000);
    await surfaces.removeTask('task-c');
    const kept = await markers();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain('task-c');
  });

  it('rejects a cyclic in-process value as invalid, not with a RangeError (COR-1638)', async () => {
    const { surfaces } = harness();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    const created = await surfaces.create(createCommand({ data: cyclic as never }));

    expect(created).toMatchObject({ outcome: 'rejected', reason: 'invalid' });
  });

  it('measures a proposal against the payload cap before compiling its schemas (COR-1638)', async () => {
    const runtime = createManualRuntimeServices();
    const storage = new MemoryStorage();
    const surfaces = createInteractiveSurfaces({
      storage,
      history: createDurableEventHistory(storage, runtime),
      task: async () => ({ owner: OWNER, contextId: 'session-1' }),
      now: () => runtime.clock.now(),
      maxPayloadBytes: 512,
    });
    // Over the cap and not a valid schema: compiling it first would report the schema.
    const oversizedAndInvalid = {
      type: 'object',
      description: 'x'.repeat(600),
      properties: { a: { type: 'not-a-type' } },
    } as never;

    const created = await surfaces.create(
      createCommand({ representation: { kind: 'input-form', schema: oversizedAndInvalid } }),
    );
    expect(created).toMatchObject({ outcome: 'rejected', reason: 'payload-too-large' });

    const small = await surfaces.create(createCommand({ commandId: 'small' }));
    expect(small).toMatchObject({ outcome: 'accepted' });
    const updated = await surfaces.update(
      updateCommand({
        commandId: 'big-update',
        representation: { kind: 'input-form', schema: oversizedAndInvalid },
      }),
    );
    expect(updated).toMatchObject({ outcome: 'rejected', reason: 'payload-too-large' });
  });

  it('releases a cleanup wait when the task is removed', async () => {
    const { surfaces } = harness();
    await surfaces.create(createCommand());
    const waiting = surfaces.closed(TASK);
    await surfaces.removeTask(TASK);

    expect(await waiting).toEqual({ status: 'not-required' });
  });

  it('keeps a settlement in flight visible to flush when the task is removed', async () => {
    const { surfaces, storage, settle } = harness();
    await surfaces.create(createCommand());
    const gate = Promise.withResolvers<void>();
    const keys = storage.keys.bind(storage);
    Reflect.set(storage, 'keys', (prefix: string, options?: unknown) => {
      const source = keys(prefix, options as never);
      return (async function* () {
        await gate.promise;
        yield* source;
      })();
    });
    settle(TASK, 'completed');
    const removing = surfaces.removeTask(TASK);
    let flushed = false;
    const flushing = surfaces.flush().then(() => {
      flushed = true;
    });
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(flushed).toBe(false);

    gate.resolve();
    await Promise.all([removing, flushing]);
    expect(flushed).toBe(true);
  });

  it('carries an approval round through admission, and lets a form answer a held human wait', async () => {
    const { surfaces } = harness();
    const approval = await surfaces.create(
      createCommand({
        commandId: 'approval',
        surfaceId: 'approval',
        actions: [
          {
            name: 'approve',
            intent: 'approve',
            continuation: { type: 'review', reviewId: 'approval:agent-run-1:call-1', round: 1 },
          },
        ],
      }),
    );
    expect(approval).toMatchObject({ outcome: 'accepted' });
    const admitted = await surfaces.act(
      actionRequest({
        commandId: 'act-approve',
        surfaceId: 'approval',
        action: 'approve',
        value: undefined,
      }),
    );
    expect(admitted).toMatchObject({
      outcome: 'accepted',
      continuation: { type: 'review', reviewId: 'approval:agent-run-1:call-1', round: 1 },
    });

    const answer = await surfaces.create(
      createCommand({
        commandId: 'answer',
        surfaceId: 'answer',
        actions: [
          {
            name: 'submit',
            intent: 'submit',
            continuation: { type: 'review', reviewId: 'human-wait:agent-run-1:reason:0' },
          },
        ],
      }),
    );
    expect(answer).toMatchObject({ outcome: 'accepted' });
    // A form may not decide a tool approval with its value.
    expect(
      await surfaces.create(
        createCommand({
          commandId: 'misused',
          surfaceId: 'misused',
          actions: [
            {
              name: 'submit',
              intent: 'submit',
              continuation: { type: 'review', reviewId: 'approval:agent-run-1:call-1' },
            },
          ],
        }),
      ),
    ).toMatchObject({ reason: 'invalid' });
  });

  it('accepts the run id of a longest session, and replays a create frozen once its task ended', async () => {
    const longRun = `${'s'.repeat(256)}:0`;
    const { surfaces, table } = harness({
      [longRun]: { owner: OWNER, contextId: 's'.repeat(256) },
      [TASK]: { owner: OWNER, contextId: 'session-1' },
    });
    expect(
      await surfaces.create(createCommand({ taskId: longRun, actions: [], commandId: 'long' })),
    ).toMatchObject({ outcome: 'accepted' });

    await surfaces.create(createCommand());
    // A settlement this process never saw (another process's, or one before a restart).
    table.set(TASK, { owner: OWNER, contextId: 'session-1', settled: 'completed' });
    expect(await surfaces.create(createCommand())).toMatchObject({
      outcome: 'accepted',
      replayed: true,
      surface: { state: 'closed', liveness: 'frozen' },
    });
  });

  it('freezes an unseen completed task’s surface as task-ended when it is aborted', async () => {
    const { surfaces, table } = harness();
    await surfaces.create(createCommand());
    table.set(TASK, { owner: OWNER, contextId: 'session-1', settled: 'completed' });

    await surfaces.abort({
      type: 'surface.owner-abort',
      contractVersion: version,
      commandId: 'abort-ended',
      taskId: TASK,
    });

    expect(await snapshotOf(surfaces)).toMatchObject({
      liveness: 'frozen',
      closeResult: { reason: 'task-ended' },
    });
  });

  it('replays an exact create retry after its review resolved', async () => {
    const held = new Set(['approval:agent-run-1:call-1']);
    const { surfaces } = harness(undefined, { reviewIdsOf: async () => held });
    const command = createCommand({
      actions: [
        {
          name: 'approve',
          intent: 'approve',
          continuation: { type: 'review', reviewId: 'approval:agent-run-1:call-1' },
        },
      ],
    });
    expect(await surfaces.create(command)).toMatchObject({ outcome: 'accepted' });
    held.clear();

    expect(await surfaces.create(command)).toMatchObject({ outcome: 'accepted', replayed: true });
  });

  it('keeps an A2UI surface on its catalog, and carries MCP Apps resource metadata', async () => {
    const { surfaces } = harness();
    const a2ui = {
      kind: 'a2ui',
      specificationVersion: 'v0.9.1',
      catalogId: 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json',
      components: [],
    } as const;
    await surfaces.create(createCommand({ actions: [], representation: a2ui }));
    expect(
      await surfaces.update(
        updateCommand({
          data: undefined,
          representation: { ...a2ui, catalogId: 'https://example.test/other-catalog.json' },
        }),
      ),
    ).toMatchObject({ reason: 'invalid' });

    expect(
      await surfaces.create(
        createCommand({
          commandId: 'app',
          surfaceId: 'app',
          actions: [],
          representation: {
            kind: 'mcp-app',
            resourceUri: 'ui://reviews/pending',
            mimeType: 'text/html;profile=mcp-app',
            contentDigest: `sha256:${'c'.repeat(64)}`,
            instanceId: 'instance-1',
            csp: { connectDomains: [], resourceDomains: [] },
            permissions: {},
            domain: 'reviews.apps.example.test',
            prefersBorder: false,
          },
        }),
      ),
    ).toMatchObject({
      outcome: 'accepted',
      surface: { representation: { domain: 'reviews.apps.example.test', prefersBorder: false } },
    });
  });

  it('requires a new instanceId when an MCP App moves to a new sandbox domain', async () => {
    const { surfaces } = harness();
    const app = {
      kind: 'mcp-app',
      resourceUri: 'ui://reviews/pending',
      mimeType: 'text/html;profile=mcp-app',
      contentDigest: `sha256:${'c'.repeat(64)}`,
      instanceId: 'instance-1',
      csp: { connectDomains: [], resourceDomains: [] },
      permissions: {},
      domain: 'one.apps.example.test',
    } as const;
    await surfaces.create(createCommand({ actions: [], representation: app }));

    expect(
      await surfaces.update(
        updateCommand({
          data: undefined,
          representation: { ...app, domain: 'two.apps.example.test' },
        }),
      ),
    ).toMatchObject({ reason: 'invalid' });
  });

  it('lets an aborted signal end the wait while a read is stuck', async () => {
    const { surfaces, table } = harness();
    await surfaces.create(createCommand());
    Reflect.set(table, 'get', () => new Promise<never>(() => {}));
    const controller = new AbortController();
    const waiting = surfaces.closed(TASK, { signal: controller.signal });
    controller.abort();

    expect(await waiting).toEqual({ status: 'unresolved', reason: 'timed-out' });
  });

  it('deletes a task’s surfaces when its retention ends', async () => {
    const { surfaces } = harness();
    await surfaces.create(createCommand());

    await surfaces.removeTask(TASK);

    expect(await surfaces.snapshot(snapshotQuery)).toMatchObject({ reason: 'not-found' });
  });
});

describe('review fixes', () => {
  const mcpApp = {
    kind: 'mcp-app',
    resourceUri: 'ui://reviews/pending',
    mimeType: 'text/html;profile=mcp-app',
    contentDigest: `sha256:${'c'.repeat(64)}`,
    instanceId: 'instance-1',
    csp: { connectDomains: [], resourceDomains: [] },
    permissions: {},
  } as const;

  it('refuses a continuation of another task’s review or session', async () => {
    const { surfaces, events } = harness();
    const otherReview = await surfaces.create(
      createCommand({
        actions: [
          {
            name: 'approve',
            intent: 'approve',
            continuation: { type: 'review', reviewId: 'approval:agent-run-2:call-1' },
          },
        ],
      }),
    );
    const otherSession = await surfaces.create(
      createCommand({
        commandId: 'create-2',
        actions: [
          {
            name: 'submit',
            intent: 'submit',
            continuation: { type: 'signal', sessionId: 'session-2', signalName: 'reason' },
          },
        ],
      }),
    );

    expect(otherReview).toMatchObject({ outcome: 'rejected', reason: 'invalid' });
    expect(otherSession).toMatchObject({ outcome: 'rejected', reason: 'invalid' });
    expect(await events()).toHaveLength(0);
  });

  it('requires an untrusted MCP App action to name its instance', async () => {
    const { surfaces } = harness();
    await surfaces.create(
      createCommand({
        representation: mcpApp,
        actions: [
          {
            name: 'approve',
            intent: 'approve',
            continuation: { type: 'review', reviewId: 'approval:agent-run-1:call-1' },
          },
        ],
      }),
    );
    const request = actionRequest({ action: 'approve', value: undefined });

    expect(await surfaces.act(request, { principal: OWNER })).toMatchObject({
      reason: 'stale-instance',
    });
    expect(
      await surfaces.act(request, { principal: OWNER, instanceId: 'instance-1' }),
    ).toMatchObject({ outcome: 'accepted' });
  });

  it('names the original commit’s revision on a replay after later changes', async () => {
    const { surfaces } = harness();
    await surfaces.create(createCommand());
    await surfaces.update(updateCommand());
    await surfaces.update(
      updateCommand({ commandId: 'update-2', baseRevision: 2, data: { reason: 'b' } }),
    );

    const replay = await surfaces.update(updateCommand());

    expect(replay).toMatchObject({ outcome: 'accepted', replayed: true, committedRevision: 2 });
    expect(replay.outcome === 'accepted' && replay.surface.revision).toBe(3);
  });

  it('freezes on its next read a surface created while its task settled', async () => {
    const runtime = createManualRuntimeServices();
    const storage = new MemoryStorage();
    let reads = 0;
    const surfaces = createInteractiveSurfaces({
      storage,
      history: createDurableEventHistory(storage, runtime),
      task: async () => {
        reads += 1;
        return reads === 1
          ? { owner: OWNER, contextId: 'session-1' }
          : { owner: OWNER, contextId: 'session-1', settled: 'canceled' };
      },
      now: () => runtime.clock.now(),
    });

    const receipt = await surfaces.create(createCommand());

    // The create committed, so it is accepted; the ended task freezes the
    // surface when it is next read.
    expect(receipt).toMatchObject({ outcome: 'accepted', committedRevision: 1 });
    expect(await snapshotOf(surfaces)).toMatchObject({
      liveness: 'frozen',
      closeResult: { reason: 'cancelled' },
    });
  });

  it('refuses an asynchronous schema and CSP entries that are not origins', async () => {
    const { surfaces } = harness();
    const asynchronous = await surfaces.create(
      createCommand({
        representation: { kind: 'input-form', schema: { type: 'object', $async: true } },
      }),
    );
    const receipts = await Promise.all(
      [
        'https://user:pass@example.test',
        'https://example.test?query',
        'https://example.test/path',
        'javascript:alert(1)',
      ].map((origin, index) =>
        surfaces.create(
          createCommand({
            commandId: `csp-${index}`,
            surfaceId: `csp-${index}`,
            representation: { ...mcpApp, csp: { connectDomains: [origin], resourceDomains: [] } },
            actions: [],
          }),
        ),
      ),
    );

    expect(asynchronous).toMatchObject({ reason: 'invalid' });
    for (const receipt of receipts) expect(receipt).toMatchObject({ reason: 'invalid' });
  });

  it('advances the content revisions when a close clears the content', async () => {
    const { surfaces } = harness();
    await surfaces.create(createCommand());

    const closed = await surfaces.close({
      type: 'surface.close',
      contractVersion: version,
      commandId: 'close-1',
      taskId: TASK,
      surfaceId: 'reason-form',
      baseRevision: 1,
      reason: 'completed',
    });

    expect(closed).toMatchObject({
      surface: { revision: 2, componentRevision: 2, dataRevision: 2 },
    });
  });

  it('never stores an action’s value in the surface record, and still replays it', async () => {
    const { surfaces, storage } = harness();
    await surfaces.create(createCommand({ classification: 'sensitive' }));
    const request = actionRequest({ value: { reason: 'account 12345' } });
    await surfaces.act(request);

    const stored: string[] = [];
    for await (const [, bytes] of storage.scan('bureau-surface:v1:')) {
      stored.push(new TextDecoder().decode(bytes));
    }
    expect(stored.join('\n')).not.toContain('account 12345');
    expect(await surfaces.act(request)).toMatchObject({
      replayed: true,
      value: { reason: 'account 12345' },
    });
  });

  it('flushes the settlement freezes in flight', async () => {
    const { surfaces } = harness();
    await surfaces.create(createCommand());

    void surfaces.settleTask(TASK, 'failed');
    await surfaces.flush();

    expect(await snapshotOf(surfaces)).toMatchObject({ closeResult: { reason: 'task-ended' } });
  });

  it('accepts origins with a default port or capital letters, and a property named $async', async () => {
    const { surfaces } = harness();
    const app = await surfaces.create(
      createCommand({
        surfaceId: 'app',
        representation: {
          ...mcpApp,
          csp: {
            connectDomains: ['https://example.com:443', 'HTTPS://Example.com'],
            resourceDomains: [],
          },
        },
        actions: [],
      }),
    );
    const form = await surfaces.create(
      createCommand({
        commandId: 'create-2',
        surfaceId: 'form',
        representation: {
          kind: 'input-form',
          schema: { type: 'object', properties: { $async: { type: 'boolean' } } },
        },
      }),
    );

    expect(app).toMatchObject({ outcome: 'accepted' });
    expect(form).toMatchObject({ outcome: 'accepted' });
  });

  it('resolves a cleanup wait for a surface created before a restart', async () => {
    const runtime = createManualRuntimeServices();
    const storage = new MemoryStorage();
    const history = createDurableEventHistory(storage, runtime);
    const task: { current: InteractiveSurfaceTask } = {
      current: { owner: OWNER, contextId: 'session-1' },
    };
    const listeners: ((status: 'completed' | 'failed' | 'canceled') => void)[] = [];
    const open = () =>
      createInteractiveSurfaces({
        storage,
        history,
        task: async () => task.current,
        now: () => runtime.clock.now(),
        watchTask: (_taskId, listener) => listeners.push(listener),
      });
    await open().create(createCommand());
    listeners.length = 0;

    const restarted = open();
    const evidence = restarted.closed(TASK);
    await Promise.resolve();
    task.current = { ...task.current, settled: 'canceled' };
    for (const listener of listeners) listener('canceled');

    expect(await evidence).toEqual({ status: 'completed' });
  });

  it('never shows an open surface of a task whose settlement already ran, or of a deleted task', async () => {
    const runtime = createManualRuntimeServices();
    const storage = new MemoryStorage();
    const live = { owner: OWNER, contextId: 'session-1' };
    const task: { current: InteractiveSurfaceTask | undefined } = { current: live };
    const surfaces = createInteractiveSurfaces({
      storage,
      history: createDurableEventHistory(storage, runtime),
      task: async () => task.current,
      now: () => runtime.clock.now(),
    });
    // The settlement ran before this surface existed.
    await surfaces.settleTask(TASK, 'canceled');
    await surfaces.create(createCommand());
    task.current = { ...live, settled: 'canceled' };

    expect(await snapshotOf(surfaces)).toMatchObject({ liveness: 'frozen' });
    expect(await surfaces.closed(TASK)).toEqual({ status: 'completed' });

    task.current = undefined;
    expect(await surfaces.snapshot(snapshotQuery)).toMatchObject({ reason: 'not-found' });
  });

  it('rejects a null classification, keeps content apart from the caller, and ignores annotation patterns', async () => {
    const { surfaces } = harness();
    const nullClassification = await surfaces.create(
      createCommand({ classification: null as unknown as 'standard' }),
    );
    const data = { reason: 'kept' };
    const pending = surfaces.create(
      createCommand({
        commandId: 'create-2',
        data,
        representation: {
          kind: 'input-form',
          schema: { type: 'object', 'x-ui': { pattern: 'compact' } },
        },
      }),
    );
    data.reason = 'changed after the call';
    const receipt = await pending;

    expect(nullClassification).toMatchObject({ reason: 'invalid' });
    expect(receipt).toMatchObject({ outcome: 'accepted', surface: { data: { reason: 'kept' } } });
  });

  it('refuses a regular-expression keyword in a surface schema, but not a property named pattern', async () => {
    const { surfaces } = harness();
    const withPattern = await surfaces.create(
      createCommand({
        representation: {
          kind: 'input-form',
          schema: { type: 'object', properties: { code: { type: 'string', pattern: '^(a+)+$' } } },
        },
      }),
    );
    const namedPattern = await surfaces.create(
      createCommand({
        commandId: 'create-2',
        surfaceId: 'named',
        representation: {
          kind: 'input-form',
          schema: { type: 'object', properties: { pattern: { type: 'string' } } },
        },
      }),
    );

    // The legacy `dependencies` keyword still holds subschemas Ajv compiles.
    const viaDependencies = await surfaces.create(
      createCommand({
        commandId: 'create-3',
        surfaceId: 'dependent',
        representation: {
          kind: 'input-form',
          schema: {
            type: 'object',
            dependencies: { a: { properties: { b: { type: 'string', pattern: '^(a+)+$' } } } },
          },
        },
      }),
    );

    expect(withPattern).toMatchObject({ reason: 'invalid' });
    expect(viaDependencies).toMatchObject({ reason: 'invalid' });
    expect(namedPattern).toMatchObject({ outcome: 'accepted' });
  });

  it('requires a new instanceId when an MCP App’s resource changes', async () => {
    const { surfaces } = harness();
    await surfaces.create(createCommand({ representation: mcpApp, actions: [] }));
    const same = await surfaces.update(
      updateCommand({
        data: undefined,
        representation: { ...mcpApp, contentDigest: `sha256:${'d'.repeat(64)}` },
      }),
    );
    const rotated = await surfaces.update(
      updateCommand({
        commandId: 'update-2',
        data: undefined,
        representation: {
          ...mcpApp,
          contentDigest: `sha256:${'d'.repeat(64)}`,
          instanceId: 'instance-2',
        },
      }),
    );

    expect(same).toMatchObject({ reason: 'invalid' });
    expect(rotated).toMatchObject({ outcome: 'accepted' });
  });
});

describe('listing a task’s surfaces', () => {
  it('returns every surface the caller may see, oldest first, and none for a stranger or an unknown task', async () => {
    const { surfaces } = harness();
    await surfaces.create(createCommand({ commandId: 'c1', surfaceId: 'first' }));
    await surfaces.create(createCommand({ commandId: 'c2', surfaceId: 'second' }));

    const own = await surfaces.list(TASK, { principal: OWNER });
    expect(own.map((surface) => surface.surfaceId).toSorted()).toEqual(['first', 'second']);
    expect(own.every((surface) => surface.eventCursor !== undefined)).toBe(true);
    expect(await surfaces.list(TASK, { principal: 'api-key:mallory' })).toEqual([]);
    expect(await surfaces.list('no-such-task')).toEqual([]);
  });
});
