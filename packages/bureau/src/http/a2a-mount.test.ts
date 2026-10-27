import { AgentCard, verifyAgentCardSignature } from '@a2a-js/sdk';
import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../test';
import { rejectionOf } from '../testing/promise-outcome.test-support.ts';
import {
  approvalToolbox,
  openBureau,
  parkingUntilAborted,
} from './management/management-fixtures.test-support.ts';
import {
  answering,
  BUREAU_ID,
  call,
  type Json,
  message,
  parksThenAnswers,
  PUBLIC_URL,
  send,
  sendForTask,
  taskOf,
  withA2A,
} from './a2a-mount.test-support.ts';
import { A2UI_EXTENSION_URI } from '../a2ui/catalogs.ts';
import { COMMAND_RECEIPTS_EXTENSION_URI } from './a2a-command-receipts.ts';
import { inclusiveBoundary, LISTED_HISTORY_BYTES } from './a2a-request-handler.ts';
import { CLEANUP_EXTENSION_URI } from './a2a-task-projection.ts';
import { TaskListingTokenError } from '../task-list-snapshots.ts';

describe('the A2A Agent Card', () => {
  it('serves each published agent’s card without credentials, projected from its definition', async () => {
    await withA2A({ asker: answering('done'), writer: answering('ok') }, async (opened) => {
      for (const name of ['asker', 'writer']) {
        const response = await opened.handler(
          new Request(`http://localhost/a2a/${name}/.well-known/agent-card.json`),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('etag')).not.toBeNull();
        expect(response.headers.get('cache-control')).toContain('max-age');
        const card: Json = await response.json();
        expect(card.name).toBe(name);
        expect(card.description).toBe(`The ${name} agent`);
        expect(typeof card.version).toBe('string');
        expect(card.version).not.toBe('');
        expect(card.supportedInterfaces).toEqual([
          {
            url: `${PUBLIC_URL}/a2a/${name}`,
            protocolBinding: 'JSONRPC',
            tenant: BUREAU_ID,
            protocolVersion: '1.0',
          },
        ]);
        expect(card.capabilities.streaming).toBe(true);
        expect(card.capabilities.pushNotifications ?? false).toBe(false);
        expect(card.capabilities.extendedAgentCard ?? false).toBe(false);
        expect(card.capabilities.extensions.map((entry: Json) => entry.uri).toSorted()).toEqual(
          [A2UI_EXTENSION_URI, CLEANUP_EXTENSION_URI, COMMAND_RECEIPTS_EXTENSION_URI].toSorted(),
        );
        expect(card.capabilities.extensions.every((entry: Json) => entry.required !== true)).toBe(
          true,
        );
        expect(Object.keys(card.securitySchemes).toSorted()).toEqual(['apiKeyHeader', 'bearer']);
        expect(card.defaultInputModes).toEqual(['text/plain', 'application/json']);
        expect(card.defaultOutputModes).toEqual(['text/plain']);
      }
    });
  });

  it('has no card, starts no task, and reads as not found for an agent that is not published', async () => {
    await withA2A(
      { asker: answering('done'), hidden: answering('no') },
      async (opened) => {
        const card = await opened.handler(
          new Request('http://localhost/a2a/hidden/.well-known/agent-card.json'),
        );
        const sent = await send(opened, 'hidden', { message: message('hello') });
        const unknown = await send(opened, 'nobody', { message: message('hello') });

        expect([card.status, sent.status, unknown.status]).toEqual([404, 404, 404]);
        expect(opened.bureau.listRuns()).toEqual([]);
      },
      { publish: ['asker'] },
    );
  });

  it('answers 401 to a JSON-RPC request without credentials', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const response = await opened.handler(
        new Request('http://localhost/a2a/asker', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } }),
        }),
      );
      expect(response.status).toBe(401);
    });
  });
});

describe('A2A versions and unsupported operations', () => {
  it('serves 1.0 and 1.0.1, and refuses an absent or other version with -32009', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const missing = await call(opened, 'asker', 'GetTask', { id: 'x' }, { version: null });
      const other = await call(opened, 'asker', 'GetTask', { id: 'x' }, { version: '0.3' });
      const patch = await call(opened, 'asker', 'GetTask', { id: 'x' }, { version: '1.0.1' });

      expect(missing.body.error.code).toBe(-32009);
      expect(other.body.error.code).toBe(-32009);
      expect(patch.body.error.code).toBe(-32001);
    });
  });

  it('refuses every push method with -32003, the extended card and streams with -32004', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const push = await Promise.all(
        [
          ['CreateTaskPushNotificationConfig', { taskId: 't', url: 'https://example.test/hook' }],
          ['GetTaskPushNotificationConfig', { taskId: 't', id: 'c' }],
          ['ListTaskPushNotificationConfigs', { taskId: 't' }],
          ['DeleteTaskPushNotificationConfig', { taskId: 't', id: 'c' }],
        ].map(([method, params]) => call(opened, 'asker', method as string, params as Json)),
      );
      const extended = await call(opened, 'asker', 'GetExtendedAgentCard', {});

      expect(push.map((entry) => entry.body.error?.code)).toEqual([-32003, -32003, -32003, -32003]);
      expect(extended.body.error.code).toBe(-32004);
    });
  });

  it('carries the A2A ErrorInfo in error.data and no Weft fault fields', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const missing = await call(opened, 'asker', 'GetTask', { id: 'no-such-task' });

      expect(missing.status).toBe(200);
      expect(missing.body.error.code).toBe(-32001);
      expect(missing.body.error.data).toEqual([
        expect.objectContaining({
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          domain: 'a2a-protocol.org',
          reason: 'TASK_NOT_FOUND',
        }),
      ]);
      expect(JSON.stringify(missing.body)).not.toContain('weftCode');
      expect(JSON.stringify(missing.body)).not.toContain('httpStatus');
    });
  });
});

describe('SendMessage creating a task', () => {
  it('waits for the reply, which is the status message, the result artifact, and the last history entry', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const sent = await send(opened, 'asker', { message: message('please') });
      const task = taskOf(sent.body);

      expect(task.status.state).toBe('TASK_STATE_COMPLETED');
      expect(task.status.message.parts).toEqual([{ text: 'done' }]);
      expect(task.status.message.role).toBe('ROLE_AGENT');
      expect(task.artifacts).toEqual([
        expect.objectContaining({ artifactId: `${task.id}:result`, parts: [{ text: 'done' }] }),
      ]);
      expect(task.history.map((entry: Json) => [entry.role, entry.parts[0].text])).toEqual([
        ['ROLE_USER', 'please'],
        ['ROLE_AGENT', 'done'],
      ]);
      expect(typeof task.contextId).toBe('string');
      expect(task.contextId).not.toBe('');

      const read = await call(opened, 'asker', 'GetTask', { id: task.id, historyLength: 1 });
      expect(taskOf(read.body).contextId).toBe(task.contextId);
      expect(taskOf(read.body).history).toHaveLength(1);
    });
  });

  it('returns at once with a stable task id when returnImmediately is set', async () => {
    await withA2A({ asker: parkingUntilAborted }, async (opened) => {
      const sent = await send(opened, 'asker', {
        message: message('please'),
        configuration: { returnImmediately: true },
      });
      const task = taskOf(sent.body);

      expect(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING']).toContain(task.status.state);
      expect(opened.bureau.getRun(task.id)).toBeDefined();
    });
  });

  it('keeps a client’s contextId exactly, and continues that context with a second task', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const first = await sendForTask(opened, 'asker', {
        message: message('one', { contextId: 'ctx-alpha' }),
      });
      const second = await sendForTask(opened, 'asker', {
        message: message('two', { contextId: 'ctx-alpha' }),
      });

      expect([first.contextId, second.contextId]).toEqual(['ctx-alpha', 'ctx-alpha']);
      expect(first.id).not.toBe(second.id);
    });
  });

  it('answers a context another caller owns as not found, before anything loads it', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      await send(
        opened,
        'asker',
        { message: message('mine', { contextId: 'ctx-bob' }) },
        { key: 'bob-key' },
      );
      const runs = opened.bureau.listRuns().length;

      const stolen = await send(opened, 'asker', {
        message: message('yours', { contextId: 'ctx-bob' }),
      });

      expect(stolen.body.error.code).toBe(-32001);
      expect(opened.bureau.listRuns()).toHaveLength(runs);
    });
  });

  it.each([
    ['no messageId', { role: 'ROLE_USER', parts: [{ text: 'x' }], messageId: '' }],
    ['no parts', { role: 'ROLE_USER', parts: [], messageId: 'p-1' }],
    ['an agent role', { role: 'ROLE_AGENT', parts: [{ text: 'x' }], messageId: 'p-2' }],
  ])('refuses a message with %s with -32602 and creates nothing', async (_label, bad) => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const refused = await send(opened, 'asker', { message: bad });
      expect(refused.body.error.code).toBe(-32602);
      expect(opened.bureau.listRuns()).toEqual([]);
    });
  });

  it('refuses another tenant with -32602 and creates nothing', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const refused = await send(opened, 'asker', {
        tenant: 'someone-else',
        message: message('x'),
      });
      expect(refused.body.error.code).toBe(-32602);
      expect(opened.bureau.listRuns()).toEqual([]);
    });
  });

  it('refuses a media type outside the agent’s input modes with -32005', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const refused = await send(opened, 'asker', {
        message: { ...message('x'), parts: [{ text: 'x', mediaType: 'image/png' }] },
      });
      expect(refused.body.error.code).toBe(-32005);
    });
  });

  it('refuses a push configuration with -32003 before admission', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const refused = await send(opened, 'asker', {
        message: message('x'),
        configuration: { taskPushNotificationConfig: { url: 'https://example.test/hook' } },
      });
      expect(refused.body.error.code).toBe(-32003);
      expect(opened.bureau.listRuns()).toEqual([]);
    });
  });

  it('refuses a referenceTaskIds entry that is not the caller’s task on this agent with -32602', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const bobs = await sendForTask(
        opened,
        'asker',
        { message: message('b') },
        { key: 'bob-key' },
      );
      const refused = await send(opened, 'asker', {
        message: message('a', { referenceTaskIds: [bobs.id] }),
      });
      expect(refused.body.error.code).toBe(-32602);
    });
  });
});

describe('A2A send idempotency', () => {
  it('returns the original task for an exact retry, whatever the response controls or correlation say', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const original = message('once', { metadata: { correlationId: 'c-1' } });
      const first = await sendForTask(opened, 'asker', { message: original });
      const retries = [
        { message: { ...original, metadata: { correlationId: 'c-2' } } },
        { message: original, configuration: { returnImmediately: true, historyLength: 0 } },
        { message: original, configuration: { acceptedOutputModes: [] } },
      ];
      for (const params of retries) {
        const retried = await sendForTask(opened, 'asker', params);
        expect(retried.id).toBe(first.id);
      }
      const patchVersion = await sendForTask(
        opened,
        'asker',
        { message: original },
        { version: '1.0.1' },
      );
      expect(patchVersion.id).toBe(first.id);
      expect(opened.bureau.listRuns()).toHaveLength(1);
    });
  });

  it('treats acceptedOutputModes as a set', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const original = message('modes');
      const first = await send(opened, 'asker', {
        message: original,
        configuration: { acceptedOutputModes: ['text/plain', 'application/json'] },
      });
      const retry = await send(opened, 'asker', {
        message: original,
        configuration: { acceptedOutputModes: ['application/json', 'text/plain', 'text/plain'] },
      });
      expect(taskOf(retry.body).id).toBe(taskOf(first.body).id);
    });
  });

  it('refuses the same messageId with a different payload with -32602, and leaves the original', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const original = message('first');
      const first = await sendForTask(opened, 'asker', { message: original });
      const conflict = await send(opened, 'asker', {
        message: { ...original, parts: [{ text: 'other' }] },
      });

      expect(conflict.body.error.code).toBe(-32602);
      expect(opened.bureau.listRuns()).toHaveLength(1);
      const retried = await sendForTask(opened, 'asker', { message: original });
      expect(retried.id).toBe(first.id);
    });
  });

  it('creates one task per agent for one messageId sent to two agents', async () => {
    await withA2A({ asker: answering('a'), writer: answering('w') }, async (opened) => {
      const shared = message('shared');
      const asked = await sendForTask(opened, 'asker', { message: shared });
      const written = await sendForTask(opened, 'writer', { message: shared });

      expect(asked.id).not.toBe(written.id);
      expect(opened.bureau.listRuns()).toHaveLength(2);
    });
  });
});

describe('A2A task queries', () => {
  it('answers another owner’s task, and another agent’s, exactly as a missing one', async () => {
    await withA2A({ asker: answering('a'), writer: answering('w') }, async (opened) => {
      const alices = await sendForTask(opened, 'asker', { message: message('a') });

      const asBob = await call(opened, 'asker', 'GetTask', { id: alices.id }, { key: 'bob-key' });
      const elsewhere = await call(opened, 'writer', 'GetTask', { id: alices.id });
      const missing = await call(opened, 'asker', 'GetTask', { id: 'no-such-task' });
      const cancelAsBob = await call(
        opened,
        'asker',
        'CancelTask',
        { id: alices.id },
        { key: 'bob-key' },
      );

      const shape = (body: Json) => ({ code: body.error.code, data: body.error.data });
      expect(shape(asBob.body)).toEqual({ ...shape(missing.body), data: asBob.body.error.data });
      expect(
        [asBob, elsewhere, missing, cancelAsBob].map((entry) => entry.body.error.code),
      ).toEqual([-32001, -32001, -32001, -32001]);
    });
  });

  it('lists only the caller’s tasks on this agent, even for an operator scope', async () => {
    await withA2A({ asker: answering('a'), writer: answering('w') }, async (opened) => {
      await send(opened, 'asker', { message: message('a') });
      await send(opened, 'asker', { message: message('b') }, { key: 'bob-key' });
      await send(opened, 'writer', { message: message('c') });

      const alice = await call(opened, 'asker', 'ListTasks', {});
      const reader = await call(opened, 'asker', 'ListTasks', {}, { key: 'tasks-reader-key' });

      expect(alice.body.result.tasks).toHaveLength(1);
      expect(alice.body.result.totalSize).toBe(1);
      expect(reader.body.result.tasks ?? []).toEqual([]);
    });
  });

  it('pages with an A2A pageToken through the snapshot listing, and trims each page as asked', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      for (let index = 0; index < 3; index += 1)
        await send(opened, 'asker', { message: message(`t${index}`) });

      const first = await call(opened, 'asker', 'ListTasks', {
        pageSize: 2,
        includeArtifacts: true,
      });
      const second = await call(opened, 'asker', 'ListTasks', {
        pageSize: 2,
        pageToken: first.body.result.nextPageToken,
        historyLength: 1,
      });
      const bad = await call(opened, 'asker', 'ListTasks', { pageToken: 'not-a-token' });
      const tooBig = await call(opened, 'asker', 'ListTasks', { pageSize: 101 });

      expect(first.body.result.tasks).toHaveLength(2);
      expect(first.body.result.tasks[0].artifacts).toHaveLength(1);
      expect(first.body.result.totalSize).toBe(3);
      expect(second.body.result.tasks).toHaveLength(1);
      expect(second.body.result.tasks[0].artifacts ?? []).toEqual([]);
      expect(second.body.result.tasks[0].history).toHaveLength(1);
      expect(second.body.result.nextPageToken ?? '').toBe('');
      expect([bad.body.error.code, tooBig.body.error.code]).toEqual([-32602, -32602]);
    });
  });

  it('filters by contextId and status', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      await send(opened, 'asker', { message: message('one', { contextId: 'ctx-one' }) });
      await send(opened, 'asker', { message: message('two', { contextId: 'ctx-two' }) });

      const inContext = await call(opened, 'asker', 'ListTasks', { contextId: 'ctx-one' });
      const completed = await call(opened, 'asker', 'ListTasks', {
        status: 'TASK_STATE_COMPLETED',
      });
      const working = await call(opened, 'asker', 'ListTasks', { status: 'TASK_STATE_WORKING' });

      expect(inContext.body.result.tasks.map((task: Json) => task.contextId)).toEqual(['ctx-one']);
      expect(completed.body.result.tasks).toHaveLength(2);
      expect(working.body.result.tasks ?? []).toEqual([]);
    });
  });
});

describe('CancelTask', () => {
  it('cancels a working task and refuses a finished or canceled one with -32002', async () => {
    await withA2A({ asker: parkingUntilAborted, done: answering('done') }, async (opened) => {
      const working = await sendForTask(opened, 'asker', {
        message: message('wait'),
        configuration: { returnImmediately: true },
      });
      await waitForCondition(
        () => opened.bureau.getRun(working.id)?.status === 'running',
        'running',
      );
      const canceled = await call(opened, 'asker', 'CancelTask', { id: working.id });
      await waitForCondition(async () => {
        const view = await opened.bureau.tasks.get(working.id);
        return view?.status === 'canceled';
      }, 'canceled');
      const again = await call(opened, 'asker', 'CancelTask', { id: working.id });
      const finished = await sendForTask(opened, 'done', { message: message('x') });
      const late = await call(opened, 'done', 'CancelTask', { id: finished.id });

      expect(taskOf(canceled.body).status.state).toBe('TASK_STATE_CANCELED');
      expect([again.body.error.code, late.body.error.code]).toEqual([-32002, -32002]);
    });
  });
});

describe('continuing a task', () => {
  it('answers a human wait with the message text, and the task completes', async () => {
    await withA2A({ asker: parksThenAnswers() }, async (opened) => {
      const parked = await sendForTask(opened, 'asker', { message: message('start') });
      expect(parked.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
      expect(parked.status.message.metadata.signalNames).toEqual(['human-response']);

      const answered = await send(opened, 'asker', {
        message: message('blue', { taskId: parked.id, contextId: parked.contextId }),
      });

      expect(answered.body.error).toBeUndefined();
      expect(taskOf(answered.body).status.state).toBe('TASK_STATE_COMPLETED');
      expect(taskOf(answered.body).history.map((entry: Json) => entry.parts[0].text)).toEqual([
        'start',
        'blue',
        'resolved',
      ]);
    });
  });

  it('refuses another context with -32602 and a finished task with -32004, admitting nothing', async () => {
    await withA2A({ asker: parksThenAnswers(), done: answering('done') }, async (opened) => {
      const parked = await sendForTask(opened, 'asker', { message: message('start') });
      const wrongContext = await send(opened, 'asker', {
        message: message('blue', { taskId: parked.id, contextId: 'another-context' }),
      });
      const finished = await sendForTask(opened, 'done', { message: message('x') });
      const late = await send(opened, 'done', {
        message: message('more', { taskId: finished.id }),
      });

      expect(wrongContext.body.error.code).toBe(-32602);
      expect(late.body.error.code).toBe(-32004);
      const still = await opened.bureau.tasks.get(parked.id);
      expect(still?.status).toBe('input-required');
    });
  });

  it('refuses a reject decision without a reason with -32602', async () => {
    await withA2A({ asker: parksThenAnswers() }, async (opened) => {
      const parked = await sendForTask(opened, 'asker', { message: message('start') });
      const refused = await send(opened, 'asker', {
        message: {
          ...message('', { taskId: parked.id }),
          parts: [{ data: { decision: 'reject' }, mediaType: 'application/json' }],
        },
      });
      expect(refused.body.error.code).toBe(-32602);
    });
  });
});

describe('A2A extension activation', () => {
  it('activates and echoes only the extensions the card declares', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const read = await call(
        opened,
        'asker',
        'ListTasks',
        {},
        {
          headers: { 'A2A-Extensions': `${CLEANUP_EXTENSION_URI}, https://example.test/unknown` },
        },
      );
      expect(read.headers.get('A2A-Extensions')).toBe(CLEANUP_EXTENSION_URI);
    });
  });

  it('activates A2UI through its X-A2A-Extensions alias', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const sent = await send(
        opened,
        'asker',
        { message: message('ui') },
        {
          headers: { 'X-A2A-Extensions': A2UI_EXTENSION_URI },
        },
      );
      expect(sent.headers.get('A2A-Extensions')).toBe(A2UI_EXTENSION_URI);
    });
  });

  it('activates A2UI through metadata.a2uiClientCapabilities without any header', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const sent = await send(opened, 'asker', {
        message: message('ui', {
          metadata: { a2uiClientCapabilities: { supportedCatalogIds: [] } },
        }),
      });
      expect(sent.headers.get('A2A-Extensions')).toBe(A2UI_EXTENSION_URI);
    });
  });

  it('keeps a task’s cleanup metadata out unless the cleanup extension is active', async () => {
    await withA2A({ asker: parkingUntilAborted }, async (opened) => {
      const task = await sendForTask(opened, 'asker', {
        message: message('wait'),
        configuration: { returnImmediately: true },
      });
      await waitForCondition(() => opened.bureau.getRun(task.id)?.status === 'running', 'running');
      await call(opened, 'asker', 'CancelTask', { id: task.id });

      const plain = await call(opened, 'asker', 'GetTask', { id: task.id });
      const active = await call(
        opened,
        'asker',
        'GetTask',
        { id: task.id },
        {
          headers: { 'A2A-Extensions': CLEANUP_EXTENSION_URI },
        },
      );

      expect(taskOf(plain.body).metadata).toBeUndefined();
      expect(taskOf(active.body).metadata[CLEANUP_EXTENSION_URI].cleanup.state).toBeDefined();
    });
  });
});

describe('the A2A per-task record', () => {
  it('records the user message with its metadata verbatim', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const sent = await sendForTask(opened, 'asker', {
        message: message('with metadata', { metadata: { trace: { deep: [1, 2] } } }),
      });
      expect(sent.history[0].metadata).toEqual({ trace: { deep: [1, 2] } });
    });
  });
});

/** A model that charges a card once, behind an approval, then reports it. */
function chargesThenReports(): GenerateFunction {
  let calls = 0;
  return async () => {
    calls += 1;
    return calls === 1
      ? {
          content: '',
          toolCalls: [{ id: 'charge-1', name: 'charge-card', arguments: { cents: 4242 } }],
        }
      : { content: 'charged', toolCalls: [] };
  };
}

describe('continuing a task by its other paths', () => {
  it('decides an approval with a decision data part, and the tool runs', async () => {
    const charges: number[] = [];
    const opened = await openBureau({
      agents: {
        payer: createAgent({
          name: 'payer',
          generate: chargesThenReports(),
          toolbox: approvalToolbox(charges),
          stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
        }),
      },
      publish: ['payer'],
      handlerOptions: { publicUrl: PUBLIC_URL },
    });
    try {
      const parked = await sendForTask(opened, 'payer', { message: message('pay') });
      expect(parked.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
      expect(parked.status.message.metadata.callIds).toEqual(['charge-1']);

      const approved = await send(opened, 'payer', {
        message: {
          ...message('', { taskId: parked.id }),
          parts: [{ data: { decision: 'approve' }, mediaType: 'application/json' }],
        },
        configuration: { returnImmediately: true },
      });

      expect(approved.body.error).toBeUndefined();
      await waitForCondition(() => charges.length === 1, 'the approved charge never ran');
      expect(charges).toEqual([4242]);
    } finally {
      await opened.dispose();
    }
  });

  it('admits a message to a working task as session input, recorded in its history', async () => {
    await withA2A({ asker: parkingUntilAborted }, async (opened) => {
      const working = await sendForTask(opened, 'asker', {
        message: message('start'),
        configuration: { returnImmediately: true },
      });
      await waitForCondition(
        () => opened.bureau.getRun(working.id)?.status === 'running',
        'running',
      );

      const followUp = await send(opened, 'asker', {
        message: message('and also this', {
          taskId: working.id,
          metadata: { deliveryMode: 'steer' },
        }),
        configuration: { returnImmediately: true },
      });
      const badMode = await send(opened, 'asker', {
        message: message('x', { taskId: working.id, metadata: { deliveryMode: 'shout' } }),
        configuration: { returnImmediately: true },
      });

      expect(followUp.body.error).toBeUndefined();
      expect(taskOf(followUp.body).history.map((entry: Json) => entry.parts[0].text)).toEqual([
        'start',
        'and also this',
      ]);
      expect(badMode.body.error.code).toBe(-32602);
    });
  });
});

describe('A2A authentication', () => {
  it('accepts each scheme the card advertises, and refuses a request without one', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const request = (headers: Record<string, string>) =>
        opened.handler(
          new Request('http://localhost/a2a/asker', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', ...headers },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ListTasks', params: {} }),
          }),
        );

      const apiKey = await request({ 'X-API-Key': 'alice-key' });
      const bearer = await request({ Authorization: 'Bearer alice-key' });
      const none = await request({});
      const basic = await request({ Authorization: 'Basic YWxpY2U6a2V5' });

      expect([apiKey.status, bearer.status, none.status, basic.status]).toEqual([
        200, 200, 401, 401,
      ]);
    });
  });
});

describe('signed Agent Cards', () => {
  async function signingKey(): Promise<CryptoKey> {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    return pair.privateKey;
  }

  it('signs each agent’s card, with its own JWKS under discoveryUrl that verifies it', async () => {
    const signing = { privateKey: await signingKey(), kid: 'card-key-1', alg: 'ES256' as const };
    await withA2A(
      { asker: answering('a'), writer: answering('w') },
      async (opened) => {
        for (const name of ['asker', 'writer']) {
          const response = await opened.handler(
            new Request(`http://localhost/a2a/${name}/.well-known/agent-card.json`),
          );
          const card = AgentCard.fromJSON(await response.json());
          const header: Json = JSON.parse(
            Buffer.from(card.signatures[0]?.protected ?? '', 'base64url').toString('utf8'),
          );
          const jku = `http://discovery.localhost/a2a/${name}/.well-known/jwks.json`;
          expect(header).toEqual({ alg: 'ES256', kid: 'card-key-1', typ: 'JOSE', jku });
          expect(card.supportedInterfaces[0]?.url).toBe(`${PUBLIC_URL}/a2a/${name}`);

          const verify = verifyAgentCardSignature(async (kid) => {
            const jwks = await opened.handler(
              new Request(`http://localhost/a2a/${name}/.well-known/jwks.json`),
            );
            expect(jwks.status).toBe(200);
            const set: { keys: JsonWebKey[] } = await jwks.json();
            const key = set.keys.find((candidate: Json) => candidate.kid === kid);
            if (key === undefined) throw new Error(`no key ${kid}`);
            return key;
          });
          await verify(card);
        }
      },
      { handlerOptions: { signing, discoveryUrl: 'http://discovery.localhost' } },
    );
  });

  it('has no signature and no JWKS route without signing', async () => {
    await withA2A({ asker: answering('a') }, async (opened) => {
      const response = await opened.handler(
        new Request('http://localhost/a2a/asker/.well-known/agent-card.json'),
      );
      const card: Json = await response.json();
      const jwks = await opened.handler(
        new Request('http://localhost/a2a/asker/.well-known/jwks.json'),
      );

      expect(card.signatures ?? []).toEqual([]);
      expect(jwks.status).toBe(404);
    });
  });
});

describe('ListTasks input', () => {
  it('refuses a statusTimestampAfter that is not a timestamp, and reads pageSize 0 as the default', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      await send(opened, 'asker', { message: message('one') });

      const bad = await call(opened, 'asker', 'ListTasks', { statusTimestampAfter: 'yesterday' });
      const unset = await call(opened, 'asker', 'ListTasks', { pageSize: 0 });

      expect(bad.body.error.code).toBe(-32602);
      expect(unset.body.result.pageSize).toBe(50);
      expect(unset.body.result.tasks).toHaveLength(1);
    });
  });

  it('accepts only an ISO 8601 date-time for statusTimestampAfter, as -32602 otherwise', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      await send(opened, 'asker', { message: message('one') });

      // `Date.parse` reads each of these, so only a strict ISO 8601 check refuses them.
      for (const timestamp of ['12/31/2026', '0', '2026-01-01', 'Jan 1 2026', '2026-01-01 00:00']) {
        const refused = await call(opened, 'asker', 'ListTasks', {
          statusTimestampAfter: timestamp,
        });
        expect([timestamp, refused.body.error?.code]).toEqual([timestamp, -32602]);
      }
      for (const timestamp of ['2026-01-01T00:00:00Z', '2026-01-01T02:00:00+02:00']) {
        const accepted = await call(opened, 'asker', 'ListTasks', {
          statusTimestampAfter: timestamp,
        });
        expect([timestamp, accepted.body.error]).toEqual([timestamp, undefined]);
        expect(accepted.body.result.tasks).toHaveLength(1);
      }
    });
  });
});

describe('ListTasks page tokens', () => {
  it('are not exchanged with the native bureau.tasks.list, in either direction', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      await send(opened, 'asker', { message: message('one') });
      await send(opened, 'asker', { message: message('two') });
      const alice = 'api-key:alice';
      const native = await opened.bureau.tasks.list({
        principal: alice,
        owner: alice,
        agentName: 'asker',
        limit: 1,
      });
      const a2a = await call(opened, 'asker', 'ListTasks', { pageSize: 1 });
      expect(native.nextPageToken).not.toBeNull();
      expect(a2a.body.result.nextPageToken).not.toBe('');

      const nativeTokenToA2A = await call(opened, 'asker', 'ListTasks', {
        pageSize: 1,
        pageToken: native.nextPageToken,
      });
      const a2aTokenToNative = await opened.bureau.tasks
        .list({
          principal: alice,
          owner: alice,
          agentName: 'asker',
          limit: 1,
          pageToken: a2a.body.result.nextPageToken,
        })
        .catch((error: unknown) => error);

      expect(nativeTokenToA2A.body.error.code).toBe(-32602);
      expect(a2aTokenToNative).toBeInstanceOf(TaskListingTokenError);
      // Its own token still pages A2A's listing.
      const next = await call(opened, 'asker', 'ListTasks', {
        pageSize: 1,
        pageToken: a2a.body.result.nextPageToken,
      });
      expect(next.body.result.tasks).toHaveLength(1);
    });
  });
});

describe('the errors of a send', () => {
  const activated = { headers: { 'A2A-Extensions': COMMAND_RECEIPTS_EXTENSION_URI } };
  const withCorrelation = (extra: Json = {}, receipts?: Json) =>
    message('hi', {
      ...extra,
      metadata: {
        correlationId: 'corr-1',
        ...(receipts === undefined ? {} : { [COMMAND_RECEIPTS_EXTENSION_URI]: receipts }),
      },
    });

  it('carry the command’s id and correlation id once the extension is activated, whatever the error', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const malformed = await send(
        opened,
        'asker',
        { message: withCorrelation({}, { deadline: 'tomorrow' }) },
        activated,
      );
      const unknownTask = await send(
        opened,
        'asker',
        { message: withCorrelation({ taskId: 'no-such-task' }) },
        activated,
      );
      const stale = await sendForTask(opened, 'asker', { message: message('first') }, activated);
      const staleRevision = await send(
        opened,
        'asker',
        {
          message: withCorrelation({ taskId: stale.id }, { expectedRevision: 'not-the-revision' }),
        },
        activated,
      );

      for (const [refused, code, sent] of [
        [malformed, -32602, malformed],
        [unknownTask, -32001, unknownTask],
        [staleRevision, undefined, staleRevision],
      ] as const) {
        expect(sent.body.error).toBeDefined();
        if (code !== undefined) expect(refused.body.error.code).toBe(code);
        const metadata = refused.body.error.data?.[0]?.metadata;
        expect(metadata?.correlationId).toBe('corr-1');
        expect(typeof metadata?.commandId).toBe('string');
        expect(metadata?.commandId).not.toBe('');
      }
    });
  });

  it('carry the correlation id, and no command id, when the extension was not activated', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const refused = await send(opened, 'asker', {
        message: withCorrelation({ taskId: 'no-such-task' }),
      });

      const metadata = refused.body.error.data?.[0]?.metadata;
      expect(metadata?.correlationId).toBe('corr-1');
      expect(metadata?.commandId).toBeUndefined();
    });
  });

  it('carry no correlation id when the message had none', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const refused = await send(
        opened,
        'asker',
        { message: message('hi', { taskId: 'no-such-task' }) },
        activated,
      );

      const metadata = refused.body.error.data?.[0]?.metadata;
      expect(metadata?.commandId).toBeDefined();
      expect(metadata?.correlationId).toBeUndefined();
    });
  });
});

describe('two identical sends at once', () => {
  it('create one task and answer both with it', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const same = message('at once');

      const [first, second] = await Promise.all([
        sendForTask(opened, 'asker', { message: same }),
        sendForTask(opened, 'asker', { message: same }),
      ]);

      expect(first.id).toBe(second.id);
      expect(opened.bureau.listRuns()).toHaveLength(1);
    });
  });
});

describe('the first review pass', () => {
  it('forwards metadata.callId to select the approval a decision decides', async () => {
    const charges: number[] = [];
    const opened = await openBureau({
      agents: {
        payer: createAgent({
          name: 'payer',
          generate: chargesThenReports(),
          toolbox: approvalToolbox(charges),
          stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
        }),
      },
      publish: ['payer'],
      handlerOptions: { publicUrl: PUBLIC_URL },
    });
    try {
      const parked = await sendForTask(opened, 'payer', { message: message('pay') });
      const decide = (callId: string) =>
        send(opened, 'payer', {
          message: {
            ...message('', { taskId: parked.id, metadata: { callId } }),
            parts: [{ data: { decision: 'approve' }, mediaType: 'application/json' }],
          },
          configuration: { returnImmediately: true },
        });

      const wrong = await decide('no-such-call');
      const right = await decide('charge-1');

      expect(wrong.body.error.code).toBe(-32602);
      expect(right.body.error).toBeUndefined();
      await waitForCondition(() => charges.length === 1, 'the approved charge never ran');
    } finally {
      await opened.dispose();
    }
  });

  it('includes a task whose status timestamp equals statusTimestampAfter', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const task = await sendForTask(opened, 'asker', { message: message('boundary') });

      const listed = await call(opened, 'asker', 'ListTasks', {
        statusTimestampAfter: task.status.timestamp,
      });

      expect(listed.body.result.tasks.map((entry: Json) => entry.id)).toEqual([task.id]);
    });
  });

  it('refuses acceptedOutputModes this agent cannot answer in, before admission', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const refused = await send(opened, 'asker', {
        message: message('json only'),
        configuration: { acceptedOutputModes: ['application/json'] },
      });

      expect(refused.body.error.code).toBe(-32005);
      expect(opened.bureau.listRuns()).toEqual([]);
    });
  });

  it('applies the handler’s maxRequestBodyBytes to A2A requests', async () => {
    await withA2A(
      { asker: answering('done') },
      async (opened) => {
        const oversized = await opened.handler(
          new Request('http://localhost/a2a/asker', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'A2A-Version': '1.0',
              'X-API-Key': 'alice-key',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'SendMessage',
              params: { message: message('x'.repeat(4096)) },
            }),
          }),
        );
        expect(oversized.status).toBe(413);
        expect(opened.bureau.listRuns()).toEqual([]);
      },
      { handlerOptions: { maxRequestBodyBytes: 1024 } },
    );
  });
});

describe('the second review pass', () => {
  it('answers a path that is not an agent’s interface or discovery route as not found', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const post = (path: string) =>
        opened.handler(
          new Request(`http://localhost${path}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'A2A-Version': '1.0',
              'X-API-Key': 'alice-key',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'SendMessage',
              params: { message: message('x') },
            }),
          }),
        );

      const extra = await post('/a2a/asker/extra');
      const malformed = await post('/a2a/%/');
      const slash = await post('/a2a/asker/');

      expect([extra.status, malformed.status, slash.status]).toEqual([404, 404, 200]);
      expect(opened.bureau.listRuns()).toHaveLength(1);
    });
  });

  it('refuses a signing key that cannot sign when the handler is built', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ]);
    const open = () =>
      withA2A({ asker: answering('done') }, async () => undefined, {
        handlerOptions: { signing: { privateKey: pair.privateKey, kid: 'k', alg: 'ES256' } },
      });
    const refused = await rejectionOf(open());
    expect(String(refused)).toContain('extractable');
  });

  it('empties a task’s A2A history when its context is deleted', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const task = await sendForTask(opened, 'asker', { message: message('private words') });
      expect(task.history.length).toBeGreaterThan(0);

      await opened.bureau.deleteSession(task.contextId);
      const read = await call(opened, 'asker', 'GetTask', { id: task.id });

      expect(read.body.result.history ?? []).toEqual([]);
      expect(JSON.stringify(read.body)).not.toContain('private words');
    });
  });

  it('answers a concurrent exact retry by its own returnImmediately, not the first send’s wait', async () => {
    await withA2A({ asker: parkingUntilAborted }, async (opened) => {
      const same = message('long');
      const blocking = send(opened, 'asker', { message: same });
      await waitForCondition(() => opened.bureau.listRuns().length === 1, 'the run never started');

      const immediate = await send(opened, 'asker', {
        message: same,
        configuration: { returnImmediately: true },
      });

      expect(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING']).toContain(
        immediate.body.result.task.status.state,
      );
      await opened.bureau.tasks.cancel(immediate.body.result.task.id, 0);
      await blocking;
    });
  });
});

describe('the third review pass', () => {
  it('reads statusTimestampAfter inclusively at any precision', () => {
    const at = Date.parse('2026-01-01T00:00:00.000Z');
    expect(inclusiveBoundary('2026-01-01T00:00:00.000Z')).toBe(at - 1);
    expect(inclusiveBoundary('2026-01-01T00:00:00Z')).toBe(at - 1);
    expect(inclusiveBoundary('2026-01-01T00:00:00.000000Z')).toBe(at - 1);
    // A task at .000Z lies before .0005Z, so the bound stays on that millisecond.
    expect(inclusiveBoundary('2026-01-01T00:00:00.0005Z')).toBe(at);
  });

  it('bounds a listed task’s history in bytes, whatever the messages hold', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const task = await sendForTask(opened, 'asker', { message: message('x'.repeat(300_000)) });

      const listed = await call(opened, 'asker', 'ListTasks', {});
      const read = await call(opened, 'asker', 'GetTask', { id: task.id });

      const entry = listed.body.result.tasks.find((candidate: Json) => candidate.id === task.id);
      expect(JSON.stringify(entry).length).toBeLessThan(LISTED_HISTORY_BYTES);
      expect(read.body.result.history.length).toBeGreaterThan(0);
    });
  });
});

describe('a context deleted and created again', () => {
  it('refuses a continuation of the earlier incarnation’s task with -32602, and lists only the new one', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const old = await sendForTask(opened, 'asker', {
        message: message('first life', { contextId: 'ctx-reused' }),
      });
      await opened.bureau.deleteSession('ctx-reused');
      const fresh = await sendForTask(opened, 'asker', {
        message: message('second life', { contextId: 'ctx-reused' }),
      });

      const continued = await send(opened, 'asker', {
        message: message('again', { taskId: old.id, contextId: 'ctx-reused' }),
      });
      const listed = await call(opened, 'asker', 'ListTasks', { contextId: 'ctx-reused' });

      expect(continued.body.error.code).toBe(-32602);
      expect(listed.body.result.tasks.map((task: Json) => task.id)).toEqual([fresh.id]);
    });
  });
});
