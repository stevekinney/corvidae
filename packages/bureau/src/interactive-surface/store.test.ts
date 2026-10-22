import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage } from '@lostgradient/weft';
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
          kind: 'a2ui',
          specificationVersion: 'v0.9.1',
          catalogId: 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json',
          components: [{ id: 'title', component: 'Text', text: 'no root' }],
        },
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

  it('reports a surface created while its task settled as frozen, not open', async () => {
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

    // The create committed, so it is accepted, reporting the surface already frozen.
    expect(receipt).toMatchObject({
      outcome: 'accepted',
      committedRevision: 1,
      surface: { state: 'closed', liveness: 'frozen', closeResult: { reason: 'cancelled' } },
    });
    expect(await snapshotOf(surfaces)).toMatchObject({ liveness: 'frozen' });
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
});
