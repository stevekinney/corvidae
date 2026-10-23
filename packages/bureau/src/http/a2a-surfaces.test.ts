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
import { createCommandLedger } from '../command-ledger.ts';
import type { InteractiveSurfaces } from '../interactive-surface/store.ts';
import { createBureauAgentCard, declaredExtensionsOf } from './a2a-agent-card.ts';
import {
  A2A_SEND_LEDGER_KEY_PREFIX,
  type A2ASendClaim,
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
    humanInput: true,
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
  const handler = createBureauA2ARequestHandler({
    publicUrl: 'http://localhost',
    agentName: 'asker',
    card: () => ({ ...card, supportedInterfaces: [], signatures: [] }),
    bureau,
    records: createA2ATaskRecords(textValueStore(new MemoryStorage())),
    ledger: createCommandLedger<A2ASendClaim, A2ASendResult>({
      kv: textValueStore(new MemoryStorage()),
      keyPrefix: A2A_SEND_LEDGER_KEY_PREFIX,
      clock: runtime.clock,
      nextConflictId: () => runtime.identifiers.next('conflict'),
    }),
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
      expect(data[0]?.metadata).toEqual({ mimeType: 'application/a2ui+json' });
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
  fixture.useSurfaces(harness.surfaces);
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
  return { fixture, task, action, message, status };
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
