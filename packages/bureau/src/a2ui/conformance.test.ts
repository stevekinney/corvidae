/**
 * COR-837 — the A2UI conformance suite: a Bureau-emitted surface, driven through the adapter and the
 * real interactive-surface store, held to the pinned v0.9.1 schemas. `bun run test:a2ui-conformance`
 * runs only this file; Bureau's `test` runs it with everything else.
 */
import { describe, expect, it } from 'bun:test';

import { A2UI_MESSAGE_DEFINITIONS, a2uiMessagesOf } from './messages';
import { parseClientMessage, toActionRequest } from './client-actions';
import {
  a2uiHarness,
  BASIC,
  CINDER,
  confirmAction,
  createMessage,
  panelComponents,
  surfaceField,
  TASK,
  updateComponentsMessage,
  version,
} from './a2ui.test-support';
import { A2UI_BASIC_CATALOG_ID, a2uiCatalogOf, offeredCatalogIds } from './catalogs';

async function createPanel(h: ReturnType<typeof a2uiHarness>, commandId = 'create') {
  return h.adapter.apply({
    taskId: TASK,
    commandId,
    messages: [createMessage('panel'), updateComponentsMessage('panel', panelComponents())],
    actions: [confirmAction],
    complete: true,
  });
}

describe('progressive rendering', () => {
  it('commits a surface in steps, each one a revision, and reports what is still missing', async () => {
    const h = a2uiHarness();
    const first = await h.adapter.apply({
      taskId: TASK,
      commandId: 'c1',
      messages: [
        createMessage('panel'),
        updateComponentsMessage('panel', panelComponents().slice(0, 4)),
      ],
      actions: [confirmAction],
    });
    expect(first).toMatchObject({ outcome: 'accepted', rootMissing: true, dangling: [] });
    expect(await surfaceField(h, 'panel', 'revision')).toBe(1);

    const second = await h.adapter.apply({
      taskId: TASK,
      commandId: 'c2',
      messages: [updateComponentsMessage('panel', panelComponents().slice(4))],
    });
    expect(second).toMatchObject({ outcome: 'accepted', rootMissing: false, dangling: [] });
    const surface = await h.snapshot('panel');
    expect(surface).toMatchObject({ revision: 2, componentRevision: 2, kind: 'a2ui' });
    expect(surface.summary).toContain('Confirm the window');

    await h.adapter.apply({
      taskId: TASK,
      commandId: 'c3',
      messages: [
        {
          version: 'v0.9.1',
          updateDataModel: { surfaceId: 'panel', path: '/note', value: 'draft' },
        },
      ],
    });
    expect(await h.snapshot('panel')).toMatchObject({
      revision: 3,
      dataRevision: 3,
      data: { note: 'draft' },
    });
  });

  it('refuses a half-finished surface when the proposal must be whole', async () => {
    const h = a2uiHarness();
    const receipt = await h.adapter.apply({
      taskId: TASK,
      commandId: 'c1',
      messages: [
        createMessage('panel'),
        updateComponentsMessage('panel', panelComponents().slice(0, 2)),
      ],
      complete: true,
    });
    expect(receipt).toMatchObject({ outcome: 'rejected', reason: 'invalid' });
  });
});

describe('stale update rejection', () => {
  it('refuses an update that builds on an old revision, and an old retry', async () => {
    const h = a2uiHarness();
    await createPanel(h);
    await h.adapter.apply({
      taskId: TASK,
      commandId: 'u1',
      baseRevision: 1,
      messages: [
        { version: 'v0.9.1', updateDataModel: { surfaceId: 'panel', value: { note: 'a' } } },
      ],
    });
    const stale = await h.adapter.apply({
      taskId: TASK,
      commandId: 'u2',
      baseRevision: 1,
      messages: [
        { version: 'v0.9.1', updateDataModel: { surfaceId: 'panel', value: { note: 'b' } } },
      ],
    });
    expect(stale).toMatchObject({
      outcome: 'rejected',
      reason: 'stale-revision',
      currentRevision: 2,
    });
    expect(await surfaceField(h, 'panel', 'data')).toEqual({ note: 'a' });
  });

  it('replays an exact retry instead of committing twice', async () => {
    const h = a2uiHarness();
    await createPanel(h);
    const again = await createPanel(h);
    expect(again).toMatchObject({ outcome: 'accepted', receipt: { replayed: true } });
    expect(await surfaceField(h, 'panel', 'revision')).toBe(1);
  });
});

describe('invalid graph repair', () => {
  it('commits nothing for a cycle, a dangling child, or an unknown property, then accepts the repair', async () => {
    const h = a2uiHarness();
    await createPanel(h);
    const cycle = await h.adapter.apply({
      taskId: TASK,
      commandId: 'bad-1',
      messages: [
        updateComponentsMessage('panel', [
          { id: 'title', component: 'Column', children: ['root'] },
        ]),
      ],
    });
    expect(cycle).toMatchObject({ outcome: 'rejected', reason: 'invalid' });
    expect(cycle.outcome === 'rejected' && cycle.issues[0]?.message).toContain('cycle');

    const dangling = await h.adapter.apply({
      taskId: TASK,
      commandId: 'bad-2',
      complete: true,
      messages: [
        updateComponentsMessage('panel', [
          { id: 'title', component: 'Column', children: ['ghost'] },
        ]),
      ],
    });
    expect(dangling.outcome === 'rejected' && dangling.issues[0]?.message).toContain('ghost');

    const unknownProperty = await h.adapter.apply({
      taskId: TASK,
      commandId: 'bad-3',
      messages: [
        updateComponentsMessage('panel', [
          { id: 'title', component: 'Text', text: 'x', onClick: 'steal()' },
        ]),
      ],
    });
    expect(unknownProperty).toMatchObject({ outcome: 'rejected', reason: 'invalid' });
    expect(await surfaceField(h, 'panel', 'revision')).toBe(1);

    const repaired = await h.adapter.apply({
      taskId: TASK,
      commandId: 'good',
      messages: [
        updateComponentsMessage('panel', [{ id: 'title', component: 'Text', text: 'Fixed' }]),
      ],
      complete: true,
    });
    expect(repaired).toMatchObject({ outcome: 'accepted' });
    expect(await surfaceField(h, 'panel', 'revision')).toBe(2);
  });

  it('names the unknown component, function, and binding', async () => {
    const h = a2uiHarness();
    const send = (components: unknown[], commandId: string) =>
      h.adapter.apply({
        taskId: TASK,
        commandId,
        messages: [createMessage('p'), updateComponentsMessage('p', components)],
      });
    const unknownComponent = await send([{ id: 'root', component: 'Script', code: 'x' }], 'a');
    expect(unknownComponent.outcome === 'rejected' && unknownComponent.issues[0]).toMatchObject({
      path: '/messages/1/updateComponents/components/0/component',
    });
    const unknownFunction = await send(
      [{ id: 'root', component: 'Text', text: { call: 'eval', args: { code: '1' } } }],
      'b',
    );
    expect(unknownFunction.outcome).toBe('rejected');
    const badBinding = await send([{ id: 'root', component: 'Text', text: { path: '/a~9' } }], 'c');
    expect(badBinding.outcome).toBe('rejected');
  });

  it('refuses a component that raises an action the surface did not declare', async () => {
    const h = a2uiHarness();
    const receipt = await h.adapter.apply({
      taskId: TASK,
      commandId: 'c',
      messages: [createMessage('panel'), updateComponentsMessage('panel', panelComponents())],
      actions: [],
    });
    expect(receipt.outcome === 'rejected' && receipt.issues[0]?.message).toContain(
      'declared actions',
    );
  });
});

describe('typed actions', () => {
  it('admits a valid action with the continuation the host declared', async () => {
    const h = a2uiHarness();
    await createPanel(h);
    const parsed = parseClientMessage([
      {
        version: 'v0.9.1',
        action: {
          name: 'confirm',
          surfaceId: 'panel',
          sourceComponentId: 'go',
          context: { note: 'ship it' },
        },
      },
    ]);
    if (!parsed.ok || parsed.kind !== 'action') throw new Error('expected an action');
    const admitted = await h.surfaces.act(
      toActionRequest(parsed.action, { taskId: TASK, commandId: 'act-1', revision: 1 }),
    );
    expect(admitted).toMatchObject({
      outcome: 'accepted',
      action: 'confirm',
      intent: 'submit',
      continuation: { type: 'signal', signalName: 'confirmed' },
      value: { note: 'ship it' },
    });
  });

  it('refuses a value the action’s schema rejects, an undeclared action, and a stale revision', async () => {
    const h = a2uiHarness();
    await createPanel(h);
    const act = async (envelope: unknown, commandId: string, revision = 1) => {
      const parsed = parseClientMessage(envelope);
      if (!parsed.ok || parsed.kind !== 'action') throw new Error('expected an action');
      return h.surfaces.act(toActionRequest(parsed.action, { taskId: TASK, commandId, revision }));
    };
    expect(
      await act({ action: { name: 'confirm', surfaceId: 'panel', context: { note: 5 } } }, 'a1'),
    ).toMatchObject({
      outcome: 'rejected',
      reason: 'invalid',
    });
    expect(
      await act({ action: { name: 'delete-everything', surfaceId: 'panel', context: {} } }, 'a2'),
    ).toMatchObject({
      outcome: 'rejected',
    });
    expect(
      await act(
        { action: { name: 'confirm', surfaceId: 'panel', context: { note: 'x' } } },
        'a3',
        9,
      ),
    ).toMatchObject({
      outcome: 'rejected',
      reason: 'stale-revision',
    });
  });

  it('cannot be turned against another principal’s surface', async () => {
    const h = a2uiHarness();
    await createPanel(h);
    const parsed = parseClientMessage({
      action: { name: 'confirm', surfaceId: 'panel', context: { note: 'x' } },
    });
    if (!parsed.ok || parsed.kind !== 'action') throw new Error('expected an action');
    const stranger = await h.surfaces.act(
      toActionRequest(parsed.action, { taskId: TASK, commandId: 'x', revision: 1 }),
      {
        principal: 'api-key:mallory',
      },
    );
    expect(stranger.outcome).toBe('rejected');
  });
});

describe('reconnecting', () => {
  it('rebuilds the same surface from a snapshot, as messages the schema accepts', async () => {
    const h = a2uiHarness();
    await createPanel(h);
    await h.adapter.apply({
      taskId: TASK,
      commandId: 'd',
      messages: [
        { version: 'v0.9.1', updateDataModel: { surfaceId: 'panel', path: '/note', value: 'x' } },
      ],
    });
    const messages = a2uiMessagesOf(await h.snapshot('panel'));
    const catalog = a2uiCatalogOf(A2UI_BASIC_CATALOG_ID)!;
    for (const message of messages) {
      const kind = Object.keys(message)[1] as keyof typeof A2UI_MESSAGE_DEFINITIONS;
      expect(catalog.messageValidator(A2UI_MESSAGE_DEFINITIONS[kind])(message)).toBe(true);
    }

    // Replaying those messages on a fresh task yields the same components and data.
    const other = a2uiHarness();
    const replay = await other.adapter.apply({
      taskId: TASK,
      commandId: 'r',
      messages,
      actions: [confirmAction],
    });
    expect(replay.outcome).toBe('accepted');
    const rebuilt = await other.snapshot('panel');
    const original = await h.snapshot('panel');
    expect(rebuilt.representation).toEqual(original.representation);
    expect(rebuilt.data).toEqual(original.data);
  });
});

describe('ownership', () => {
  it('refuses an update from another task or another principal, and leaves the surface alone', async () => {
    const h = a2uiHarness({
      'agent-run-1': { owner: 'api-key:alice', contextId: 'session-1' },
      'agent-run-2': { owner: 'api-key:bob', contextId: 'session-2' },
    });
    await createPanel(h);
    const update = [
      updateComponentsMessage('panel', [{ id: 'title', component: 'Text', text: 'pwned' }]),
    ];
    const fromOtherTask = await h.adapter.apply(
      { taskId: TASK, commandId: 'x1', messages: update },
      { taskId: 'agent-run-2' },
    );
    const fromOtherPrincipal = await h.adapter.apply(
      { taskId: TASK, commandId: 'x2', messages: update },
      { principal: 'api-key:bob' },
    );
    const onOtherTask = await h.adapter.apply({
      taskId: 'agent-run-2',
      commandId: 'x3',
      messages: update,
    });
    expect(fromOtherTask.outcome).toBe('rejected');
    expect(fromOtherPrincipal.outcome).toBe('rejected');
    expect(onOtherTask.outcome).toBe('rejected');
    expect(await surfaceField(h, 'panel', 'revision')).toBe(1);
  });
});

describe('owner cancellation, deletion, and cleanup', () => {
  it('freezes a cancelled task’s surface read-only', async () => {
    const h = a2uiHarness();
    await createPanel(h);
    const aborted = await h.surfaces.abort({
      type: 'surface.owner-abort',
      contractVersion: version,
      commandId: 'abort',
      taskId: TASK,
    });
    expect(aborted).toMatchObject({ outcome: 'accepted', frozen: 1 });
    const frozen = await h.snapshot('panel');
    expect(frozen).toMatchObject({ liveness: 'frozen' });
    expect(frozen.representation).not.toBeNull();
    const update = await h.adapter.apply({
      taskId: TASK,
      commandId: 'late',
      messages: [
        updateComponentsMessage('panel', [{ id: 'title', component: 'Text', text: 'late' }]),
      ],
    });
    expect(update).toMatchObject({ outcome: 'rejected', reason: 'closed' });
  });

  it('deletes a surface, and refuses everything after', async () => {
    const h = a2uiHarness();
    await createPanel(h);
    const deleted = await h.adapter.apply({
      taskId: TASK,
      commandId: 'del',
      messages: [{ version: 'v0.9.1', deleteSurface: { surfaceId: 'panel' } }],
    });
    expect(deleted).toMatchObject({ outcome: 'accepted' });
    expect(await h.snapshot('panel')).toMatchObject({ state: 'closed', liveness: 'torn-down' });
    const after = await h.adapter.apply({
      taskId: TASK,
      commandId: 'again',
      messages: [updateComponentsMessage('panel', [{ id: 'title', component: 'Text', text: 'x' }])],
    });
    expect(after).toMatchObject({ outcome: 'rejected', reason: 'closed' });
  });

  it('refuses a delete mixed with other messages', async () => {
    const h = a2uiHarness();
    await createPanel(h);
    const mixed = await h.adapter.apply({
      taskId: TASK,
      commandId: 'm',
      messages: [
        updateComponentsMessage('panel', [{ id: 'title', component: 'Text', text: 'x' }]),
        { version: 'v0.9.1', deleteSurface: { surfaceId: 'panel' } },
      ],
    });
    expect(mixed.outcome).toBe('rejected');
  });

  it('resolves the task’s cleanup once its surfaces are frozen', async () => {
    const h = a2uiHarness();
    await createPanel(h);
    const pending = await h.surfaces.cleanup({
      type: 'surface.cleanup',
      contractVersion: version,
      taskId: TASK,
    });
    expect(pending).toMatchObject({ outcome: 'pending', open: 1 });
    h.settle(TASK, 'completed');
    expect(await h.surfaces.closed(TASK)).toMatchObject({ status: 'completed' });
    expect(await h.snapshot('panel')).toMatchObject({ liveness: 'frozen' });
  });
});

describe('catalog negotiation', () => {
  const checkbox = [{ id: 'root', component: 'Checkbox', label: 'Accept' }];

  it('offers the basic catalog by default and Cinder only on request', () => {
    expect(offeredCatalogIds(undefined)).toEqual([BASIC]);
    expect(offeredCatalogIds([CINDER])).toEqual([CINDER]);
    expect(offeredCatalogIds([BASIC, CINDER, 'https://example.com/x'])).toEqual([BASIC, CINDER]);
    expect(offeredCatalogIds(['https://example.com/x'])).toEqual([]);
  });

  it('refuses Cinder unless the client listed it, and any catalog it does not know', async () => {
    const h = a2uiHarness();
    const request = (catalogId: string, supportedCatalogIds?: string[]) =>
      h.adapter.apply({
        taskId: TASK,
        commandId: `c-${catalogId.length}-${supportedCatalogIds?.length ?? 0}`,
        messages: [createMessage('s', catalogId), updateComponentsMessage('s', checkbox)],
        ...(supportedCatalogIds === undefined ? {} : { supportedCatalogIds }),
      });
    expect(await request(CINDER)).toMatchObject({
      outcome: 'rejected',
      reason: 'unsupported-capability',
    });
    expect(await request('https://example.com/rogue')).toMatchObject({
      outcome: 'rejected',
      reason: 'unsupported-capability',
    });
    expect(await request(BASIC, [CINDER])).toMatchObject({
      outcome: 'rejected',
      reason: 'unsupported-capability',
    });
    expect(await request(CINDER, [CINDER])).toMatchObject({ outcome: 'accepted' });
    expect(await surfaceField(h, 's', 'representation')).toMatchObject({ catalogId: CINDER });
  });

  it('holds a surface to its own catalog: Cinder’s Checkbox is not a basic component', async () => {
    const h = a2uiHarness();
    const receipt = await h.adapter.apply({
      taskId: TASK,
      commandId: 'c',
      messages: [createMessage('s'), updateComponentsMessage('s', checkbox)],
    });
    expect(receipt).toMatchObject({ outcome: 'rejected', reason: 'invalid' });
  });
});

describe('accessible names stay the catalog’s requirement', () => {
  it('refuses a control with no label or text, in either catalog', async () => {
    const h = a2uiHarness();
    const unlabeled = [
      [BASIC, { id: 'root', component: 'TextField', value: { path: '/a' } }],
      [BASIC, { id: 'root', component: 'CheckBox', value: { path: '/a' } }],
      [CINDER, { id: 'root', component: 'Checkbox' }],
    ] as const;
    for (const [index, [catalogId, component]] of unlabeled.entries()) {
      const receipt = await h.adapter.apply({
        taskId: TASK,
        commandId: `n${index}`,
        supportedCatalogIds: [BASIC, CINDER],
        messages: [
          createMessage(`s${index}`, catalogId),
          updateComponentsMessage(`s${index}`, [component]),
        ],
      });
      expect(receipt).toMatchObject({ outcome: 'rejected', reason: 'invalid' });
    }
  });
});

describe('the batch contract', () => {
  it('needs 1 to 64 messages for one surface, with createSurface first', async () => {
    const h = a2uiHarness();
    const apply = async (messages: unknown) => {
      const receipt = await h.adapter.apply({ taskId: TASK, commandId: 'x', messages });
      return receipt.outcome;
    };
    expect(await apply([])).toBe('rejected');
    expect(await apply('nope')).toBe('rejected');
    expect(await apply(Array.from({ length: 65 }, () => createMessage('a')))).toBe('rejected');
    expect(await apply([createMessage('a'), createMessage('b')])).toBe('rejected');
    expect(await apply([updateComponentsMessage('a', panelComponents()), createMessage('a')])).toBe(
      'rejected',
    );
    expect(await apply([updateComponentsMessage('missing', panelComponents())])).toBe('rejected');
  });

  it('does not touch a surface of another kind', async () => {
    const h = a2uiHarness();
    await h.surfaces.create({
      type: 'surface.create',
      contractVersion: version,
      commandId: 'f',
      taskId: TASK,
      surfaceId: 'form',
      summary: 'A form',
      representation: {
        kind: 'input-form',
        schema: { type: 'object', properties: { a: { type: 'string' } } },
      },
      actions: [],
    });
    const receipt = await h.adapter.apply({
      taskId: TASK,
      commandId: 'x',
      messages: [updateComponentsMessage('form', [{ id: 'root', component: 'Text', text: 'x' }])],
    });
    expect(receipt).toMatchObject({ outcome: 'rejected', reason: 'invalid' });
  });
});
