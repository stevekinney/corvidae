/**
 * COR-837 — a task's A2UI surfaces are read over A2A: a request that activated A2UI's extension gets
 * each surface as a data part, any other request gets its text summary, and the card advertises the
 * extension's catalogs and its experimental status. The handler here is the real one over a real
 * parked task; its surfaces are the interactive-surface store the A2UI adapter writes to.
 */
import { Message, type Task, TaskState } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, type GenerateContext, type GenerateFunction } from '@lostgradient/operative';
import { MemoryStorage, principalFromApiKey, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../test';
import { rejectionOf } from '../testing/promise-outcome.test-support.ts';

import {
  A2UI_BASIC_CATALOG_ID,
  A2UI_CINDER_CATALOG_ID,
  A2UI_EXTENSION_URI,
} from '../a2ui/catalogs.ts';
import { a2uiHarness, createMessage, updateComponentsMessage } from '../a2ui/a2ui.test-support.ts';
import { COMMAND_RECEIPTS_EXTENSION_URI } from './a2a-command-receipts.ts';
import { createCommandLedger } from '../command-ledger.ts';
import type { InteractiveSurfaces } from '../interactive-surface/store.ts';
import { surfaceParts } from './a2a-task-projection.ts';
import { createBureauAgentCard, declaredExtensionsOf } from './a2a-agent-card.ts';
import {
  A2A_SEND_LEDGER_KEY_PREFIX,
  type A2ASendClaim,
  type A2ASendLedger,
  type A2ASendResult,
  BureauA2AUser,
  createBureauA2ARequestHandler,
} from './a2a-request-handler.ts';
import { createA2ATaskRecords } from './a2a-task-record.ts';
import { buildBureauHandlerHost } from './create-bureau-handler.ts';
import { openBureau } from './management/management-fixtures.test-support.ts';
import { respondToTask } from './management/tasks-respond-operation.ts';

function parksThenFinishes(): GenerateFunction {
  let calls = 0;
  return async (_context: GenerateContext) => {
    calls += 1;
    return calls === 1
      ? {
          content: '',
          toolCalls: [
            {
              id: 'wait-1',
              name: 'requestHumanInput',
              arguments: { signalName: 'go', prompt: 'Ready?' },
            },
          ],
        }
      : { content: 'done', toolCalls: [] };
  };
}

async function open() {
  const opened = await openBureau({
    agents: { asker: createAgent({ name: 'asker', generate: parksThenFinishes() }) },
    publish: ['asker'],
  });
  let store: InteractiveSurfaces | undefined;
  const bureau = Object.create(opened.bureau, {
    surfaces: { get: () => store },
  }) as typeof opened.bureau;
  const runtime = createDefaultRuntimeServices();
  const host = buildBureauHandlerHost(bureau, ['asker']);
  const card = createBureauAgentCard({
    catalogName: 'asker',
    displayName: undefined,
    description: undefined,
    definitionRevision: 1,
    skillDescriptors: undefined,
    security: undefined,
    durableHistory: false,
    pushNotifications: false,
  });
  const inner = createCommandLedger<A2ASendClaim, A2ASendResult>({
    kv: textValueStore(new MemoryStorage()),
    keyPrefix: A2A_SEND_LEDGER_KEY_PREFIX,
    clock: runtime.clock,
    nextConflictId: () => runtime.identifiers.next('conflict'),
  });
  let failNextComplete = false;
  const ledger: A2ASendLedger = {
    ...inner,
    async complete(entry, result) {
      if (failNextComplete) {
        failNextComplete = false;
        throw new Error('the ledger write failed');
      }
      return inner.complete(entry, result);
    },
  };
  const handler = createBureauA2ARequestHandler({
    publicUrl: 'http://localhost',
    agentName: 'asker',
    card: () => ({ ...card, supportedInterfaces: [], signatures: [] }),
    bureau,
    records: createA2ATaskRecords(textValueStore(new MemoryStorage())),
    ledger,
    respond: (principal, input) => respondToTask(host, principal, input),
  });
  const principal = principalFromApiKey({ subject: 'alice', scopes: [] });
  const context = (requestedExtensions: string[] = []) =>
    new ServerCallContext({
      user: new BureauA2AUser(principal),
      requestedVersion: '1.0',
      requestedExtensions,
    });
  const start = async (): Promise<Task> => {
    const parked = await handler.sendMessage(
      {
        tenant: '',
        message: Message.fromJSON({
          messageId: 'm-start',
          role: 'ROLE_USER',
          parts: [{ text: 'go' }],
        }),
        configuration: undefined,
        metadata: undefined,
      },
      context(),
    );
    if (!('status' in parked)) throw new Error('expected a task');
    expect(parked.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    return parked;
  };
  const send = (message: Message, extensions: string[] = []) =>
    handler.sendMessage(
      { tenant: '', message, configuration: undefined, metadata: undefined },
      context(extensions),
    );
  const read = (id: string, extensions: string[] = []) =>
    handler.getTask({ tenant: '', id, historyLength: undefined }, context(extensions));
  return {
    opened,
    card,
    start,
    read,
    send,
    failNextComplete: () => {
      failNextComplete = true;
    },
    useSurfaces: (next: InteractiveSurfaces) => {
      store = next;
    },
  };
}

async function withSurface() {
  const fixture = await open();
  const task = await fixture.start();
  const harness = a2uiHarness({ [task.id]: { owner: 'api-key:alice', contextId: task.contextId } });
  fixture.useSurfaces(harness.surfaces);
  const created = await harness.adapter.apply({
    taskId: task.id,
    commandId: 'c1',
    complete: true,
    summary: 'Pick a window',
    messages: [
      createMessage('panel'),
      updateComponentsMessage('panel', [
        { id: 'title', component: 'Text', text: 'Pick a window' },
        { id: 'root', component: 'Column', children: ['title'] },
      ]),
    ],
  });
  expect(created.outcome).toBe('accepted');
  return { fixture, task };
}

describe('reading a task with an A2UI surface', () => {
  it('gives a client that activated the extension the surface as an A2UI data part', async () => {
    const { fixture, task } = await withSurface();
    try {
      const read = await fixture.read(task.id, [A2UI_EXTENSION_URI]);
      const data = (read.status?.message?.parts ?? []).filter(
        (part) => part.content?.$case === 'data',
      );
      expect(data).toHaveLength(1);
      expect(data[0]?.mediaType).toBe('application/a2ui+json');
      expect(data[0]?.metadata).toEqual({
        mimeType: 'application/a2ui+json',
        surfaceId: 'panel',
        a2uiSurfaceRevision: 1,
      });
      const messages =
        data[0]?.content?.$case === 'data'
          ? (data[0].content.value as Record<string, unknown>[])
          : [];
      expect(messages.map((message) => Object.keys(message)[1])).toEqual([
        'createSurface',
        'updateComponents',
        'updateDataModel',
      ]);
      expect(messages[0]).toMatchObject({
        createSurface: { surfaceId: 'panel', catalogId: A2UI_BASIC_CATALOG_ID },
      });
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('gives a client that did not activate it the text summary instead', async () => {
    const { fixture, task } = await withSurface();
    try {
      const read = await fixture.read(task.id);
      const parts = read.status?.message?.parts ?? [];
      expect(parts.some((part) => part.content?.$case === 'data')).toBe(false);
      expect(
        parts.some(
          (part) => part.content?.$case === 'text' && part.content.value === 'Pick a window',
        ),
      ).toBe(true);
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('is unchanged for a task with no surface', async () => {
    const fixture = await open();
    try {
      const task = await fixture.start();
      const read = await fixture.read(task.id, [A2UI_EXTENSION_URI]);
      expect(read.status?.message?.parts.every((part) => part.content?.$case === 'text')).toBe(
        true,
      );
    } finally {
      await fixture.opened.dispose();
    }
  });
});

describe('the agent card’s A2UI extension', () => {
  it('advertises both catalogs and marks the support experimental', async () => {
    const fixture = await open();
    try {
      const extension = fixture.card.capabilities?.extensions?.find(
        (entry) => entry.uri === A2UI_EXTENSION_URI,
      );
      expect(extension).toMatchObject({
        required: false,
        params: {
          supportedCatalogIds: [A2UI_BASIC_CATALOG_ID, A2UI_CINDER_CATALOG_ID],
          acceptsInlineCatalogs: false,
          experimental: true,
        },
      });
      expect(declaredExtensionsOf(fixture.card).has(A2UI_EXTENSION_URI)).toBe(true);
    } finally {
      await fixture.opened.dispose();
    }
  });
});

const goAhead = {
  name: 'go-ahead',
  intent: 'submit' as const,
  continuation: { type: 'signal' as const, sessionId: '', signalName: 'go' },
};

async function withButton() {
  const fixture = await open();
  const task = await fixture.start();
  const harness = a2uiHarness({ [task.id]: { owner: 'api-key:alice', contextId: task.contextId } });
  // Counts the actions the surface store admitted: an admitted action is an event no answer can
  // withdraw, so a send that cannot apply must not cause one.
  const admitted = { count: 0 };
  fixture.useSurfaces(
    new Proxy(harness.surfaces, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (property !== 'act') return value;
        return (...parameters: Parameters<typeof target.act>) => {
          admitted.count += 1;
          return target.act(...parameters);
        };
      },
    }),
  );
  const created = await harness.adapter.apply({
    taskId: task.id,
    commandId: 'c1',
    complete: true,
    messages: [
      createMessage('panel'),
      updateComponentsMessage('panel', [
        { id: 'label', component: 'Text', text: 'Go ahead' },
        {
          id: 'button',
          component: 'Button',
          child: 'label',
          action: { event: { name: 'go-ahead' } },
        },
        { id: 'root', component: 'Column', children: ['button'] },
      ]),
    ],
    actions: [{ ...goAhead, continuation: { ...goAhead.continuation, sessionId: task.contextId } }],
  });
  expect(created.outcome).toBe('accepted');
  const action = (overrides: Record<string, unknown> = {}) => [
    {
      version: 'v0.9.1',
      action: {
        name: 'go-ahead',
        surfaceId: 'panel',
        sourceComponentId: 'button',
        timestamp: '2026-10-23T12:00:00.000Z',
        context: {},
        ...overrides,
      },
    },
  ];
  const message = (messageId: string, data: unknown, metadata?: Record<string, unknown>) =>
    Message.fromJSON({
      messageId,
      taskId: task.id,
      role: 'ROLE_USER',
      parts: [{ data }],
      ...(metadata === undefined ? {} : { metadata }),
    });
  const status = async () => {
    const view = await fixture.opened.bureau.tasks.get(task.id);
    return view?.status;
  };
  const update = async () => {
    const updated = await harness.adapter.apply({
      taskId: task.id,
      commandId: 'c2',
      baseRevision: 1,
      complete: true,
      messages: [
        updateComponentsMessage('panel', [
          { id: 'label', component: 'Text', text: 'Go ahead now' },
        ]),
      ],
    });
    expect(updated).toMatchObject({ outcome: 'accepted' });
  };
  return { fixture, task, action, message, status, update, admitted };
}

describe('an A2UI action sent to the task', () => {
  it('is admitted by the surface and answers the wait its host declared', async () => {
    const { fixture, action, message, status } = await withButton();
    try {
      await fixture.send(message('m-go', action()), [A2UI_EXTENSION_URI]);
      await waitForCondition(
        async () => (await status()) === 'completed',
        'the task never completed',
      );
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('is refused when the surface declares no such action, leaving the wait open', async () => {
    const { fixture, action, message, status } = await withButton();
    try {
      const refusal = await rejectionOf(
        fixture.send(message('m-bad', action({ name: 'delete-everything' })), [A2UI_EXTENSION_URI]),
      );
      expect(String(refusal)).toContain('refused the action');
      expect(await status()).toBe('input-required');
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('is refused when it states a revision the surface has moved past', async () => {
    const { fixture, action, message, status } = await withButton();
    try {
      const refusal = await rejectionOf(
        fixture.send(message('m-stale', action(), { a2uiSurfaceRevision: 99 }), [
          A2UI_EXTENSION_URI,
        ]),
      );
      expect(String(refusal)).toContain('stale-revision');
      expect(await status()).toBe('input-required');
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('is not read as a surface action by a client that did not activate the extension', async () => {
    const { fixture, action, message, status } = await withButton();
    try {
      await rejectionOf(fixture.send(message('m-plain', action())));
      expect(await status()).toBe('input-required');
    } finally {
      await fixture.opened.dispose();
    }
  });
});

async function errorOf(promise: Promise<unknown>) {
  const error = (await rejectionOf(promise)) as {
    toErrorInfo?: () => { reason: string; domain: string; metadata: Record<string, string> };
  };
  return error;
}

describe('the revision an A2UI action must echo', () => {
  it('is sent on the surface part and accepted when it matches', async () => {
    const { fixture, task, action, message, status, update } = await withButton();
    try {
      await update();
      const read = await fixture.read(task.id, [A2UI_EXTENSION_URI]);
      const part = (read.status?.message?.parts ?? []).find((p) => p.content?.$case === 'data');
      expect(part?.metadata).toMatchObject({ surfaceId: 'panel', a2uiSurfaceRevision: 2 });
      await fixture.send(message('m-ok', action(), { a2uiSurfaceRevision: 2 }), [
        A2UI_EXTENSION_URI,
      ]);
      await waitForCondition(
        async () => (await status()) === 'completed',
        'the task never completed',
      );
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('may be left out only while the surface is still at revision 1', async () => {
    const { fixture, action, message, status } = await withButton();
    try {
      await fixture.send(message('m-r1', action()), [A2UI_EXTENSION_URI]);
      await waitForCondition(
        async () => (await status()) === 'completed',
        'the task never completed',
      );
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('is refused as stale when left out of an action on an updated surface', async () => {
    const { fixture, action, message, status, update } = await withButton();
    try {
      await update();
      const error = await errorOf(fixture.send(message('m-r2', action()), [A2UI_EXTENSION_URI]));
      expect(error.toErrorInfo?.()).toMatchObject({
        reason: 'STALE_REVISION',
        domain: 'bureau',
        metadata: { surfaceId: 'panel', currentRevision: '2' },
      });
      expect(await status()).toBe('input-required');
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('is refused as stale when it names an older revision', async () => {
    const { fixture, action, message, status, update } = await withButton();
    try {
      await update();
      const error = await errorOf(
        fixture.send(message('m-old', action(), { a2uiSurfaceRevision: 1 }), [A2UI_EXTENSION_URI]),
      );
      expect(error.toErrorInfo?.()).toMatchObject({ reason: 'STALE_REVISION', domain: 'bureau' });
      expect(await status()).toBe('input-required');
    } finally {
      await fixture.opened.dispose();
    }
  });
});

describe('a retry of an applied A2UI action', () => {
  it('completes from the recorded answer when the receipt write failed after the answer', async () => {
    const { fixture, action, message, status } = await withButton();
    try {
      fixture.failNextComplete();
      const first = message('m-retry', action());
      await rejectionOf(fixture.send(first, [A2UI_EXTENSION_URI]));
      await waitForCondition(
        async () => (await status()) === 'completed',
        'the task never completed',
      );
      const retried = await fixture.send(message('m-retry', action()), [A2UI_EXTENSION_URI]);
      expect('status' in retried).toBe(true);
      expect(await status()).toBe('completed');
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('is a conflict when the same messageId carries a different payload', async () => {
    const { fixture, action, message } = await withButton();
    try {
      fixture.failNextComplete();
      await rejectionOf(fixture.send(message('m-same', action()), [A2UI_EXTENSION_URI]));
      const error = await errorOf(
        fixture.send(message('m-same', action({ context: { other: 1 } })), [A2UI_EXTENSION_URI]),
      );
      expect(error.toErrorInfo?.()).toMatchObject({ reason: 'INVALID_PARAMS' });
    } finally {
      await fixture.opened.dispose();
    }
  });
});

describe('an A2UI action whose deadline has passed', () => {
  it('admits nothing, answers the deadline receipt, and leaves the wait open', async () => {
    const { fixture, action, message, status, admitted } = await withButton();
    try {
      const expired = message('m-late', action(), {
        [COMMAND_RECEIPTS_EXTENSION_URI]: { deadline: '2020-01-01T00:00:00Z' },
      });
      const answered = await fixture.send(expired, [
        A2UI_EXTENSION_URI,
        COMMAND_RECEIPTS_EXTENSION_URI,
      ]);
      expect('status' in answered).toBe(true);
      expect(admitted.count).toBe(0);
      expect(await status()).toBe('input-required');
    } finally {
      await fixture.opened.dispose();
    }
  });
});

describe('the catalogs the requesting client supports', () => {
  const surface = (catalogId: string, summary: string) =>
    ({
      kind: 'a2ui',
      surfaceId: summary,
      revision: 1,
      summary,
      representation: { kind: 'a2ui', catalogId, components: [] },
    }) as never;
  const surfaces = [
    surface(A2UI_BASIC_CATALOG_ID, 'basic-one'),
    surface(A2UI_CINDER_CATALOG_ID, 'cinder-one'),
  ];
  const kinds = (supported: readonly string[] | undefined) =>
    surfaceParts(surfaces, new Set([A2UI_EXTENSION_URI]), supported).map((part) =>
      part.content?.$case === 'data' ? 'data' : 'text',
    );

  it('sends A2UI data only for a surface whose catalog the client supports', () => {
    expect(kinds([A2UI_BASIC_CATALOG_ID])).toEqual(['data', 'text']);
    expect(kinds([A2UI_BASIC_CATALOG_ID, A2UI_CINDER_CATALOG_ID])).toEqual(['data', 'data']);
  });

  it('sends text for every surface when the client lists no supported catalog', () => {
    expect(kinds([])).toEqual(['text', 'text']);
  });

  it('offers the basic catalog only when the client declared nothing', () => {
    expect(kinds(undefined)).toEqual(['data', 'text']);
  });
});
