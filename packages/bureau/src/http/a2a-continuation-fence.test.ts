/**
 * What a continuation of a task is fenced to (COR-1661): the session incarnation it was checked
 * against, and the revision it named.
 */
import type { GenerateFunction } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../test';
import { COMMAND_RECEIPTS_EXTENSION_URI } from './a2a-command-receipts.ts';
import {
  call,
  type Json,
  message,
  PUBLIC_URL,
  send,
  sendForTask,
  withA2A,
} from './a2a-mount.test-support.ts';
import { createA2ATaskRecords } from './a2a-task-record.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import {
  authentication,
  type OpenedBureau,
} from './management/management-fixtures.test-support.ts';

/** Holds its first step until released, so the task is still working while input reaches it. */
function gated(): { generate: GenerateFunction; release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  return {
    release: () => release(),
    generate: async () => {
      calls += 1;
      if (calls === 1) await gate;
      return { content: `reply ${calls}`, toolCalls: [] };
    },
  };
}

describe('a continuation’s admission', () => {
  it('names the session incarnation the task belongs to', async () => {
    const run = gated();
    await withA2A({ asker: run.generate }, async (opened: OpenedBureau) => {
      const started = await sendForTask(opened, 'asker', {
        message: message('start'),
        configuration: { returnImmediately: true },
      });
      const submitted: Array<{ readonly incarnation?: string | undefined }> = [];
      const spying = Object.create(opened.bureau, {
        submitSessionInput: {
          value: (sessionId: string, request: { incarnation?: string }) => {
            submitted.push(request);
            return opened.bureau.submitSessionInput(sessionId, request as never);
          },
        },
      });
      const handler = createBureauHandler(spying, {
        authentication,
        publish: ['asker'],
        publicUrl: 'http://localhost',
      });
      const session = await opened.bureau.getSession(started.contextId);

      const response = await handler(
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
            params: {
              message: message('more', { taskId: started.id }),
              configuration: { returnImmediately: true },
            },
          }),
        }),
      );

      const body: Json = await response.json();
      expect(body.error).toBeUndefined();
      expect(session?.incarnation).toBeTruthy();
      expect(submitted.map((request) => request.incarnation)).toEqual([session?.incarnation]);
      run.release();
      await waitForCondition(async () => {
        const read = await call(opened, 'asker', 'GetTask', { id: started.id });
        return read.body.result.status.state === 'TASK_STATE_COMPLETED';
      }, 'the task never completed');
    });
  });
});

describe('two continuations that name the same revision', () => {
  const activated = { headers: { 'A2A-Extensions': COMMAND_RECEIPTS_EXTENSION_URI } };
  const receiptsOf = (task: Json): Json => task.metadata[COMMAND_RECEIPTS_EXTENSION_URI];

  it('have one winner: the other is refused as stale, and only the winner’s message is admitted', async () => {
    const run = gated();
    await withA2A({ asker: run.generate }, async (opened) => {
      const started = await sendForTask(
        opened,
        'asker',
        { message: message('start'), configuration: { returnImmediately: true } },
        activated,
      );
      const revision = receiptsOf(started).revision;
      const continuation = (text: string) =>
        send(
          opened,
          'asker',
          {
            message: message(text, {
              taskId: started.id,
              metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: { expectedRevision: revision } },
            }),
            configuration: { returnImmediately: true },
          },
          activated,
        );

      const [first, second] = await Promise.all([
        continuation('first input'),
        continuation('second input'),
      ]);

      const refused = [first, second].filter((sent) => sent.body.error !== undefined);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.body.error.data[0].reason).toBe('STALE_REVISION');
      run.release();
      await waitForCondition(async () => {
        const read = await call(opened, 'asker', 'GetTask', { id: started.id });
        return read.body.result.status.state === 'TASK_STATE_COMPLETED';
      }, 'the task never completed');
      const read = await call(opened, 'asker', 'GetTask', { id: started.id });
      const history = JSON.stringify(read.body.result.history);
      expect(['first input', 'second input'].filter((text) => history.includes(text))).toHaveLength(
        1,
      );
    });
  });

  it('have one winner across two handler instances sharing one store (COR-1694)', async () => {
    const run = gated();
    await withA2A({ asker: run.generate }, async (opened) => {
      const submitted: string[] = [];
      const spying = Object.create(opened.bureau, {
        submitSessionInput: {
          value: (sessionId: string, request: { id: string }) => {
            submitted.push(request.id);
            return opened.bureau.submitSessionInput(sessionId, request as never);
          },
        },
      });
      // Two instances: each has its own in-process fence and reads and writes the one store.
      const instance = () =>
        createBureauHandler(spying, { authentication, publish: ['asker'], publicUrl: PUBLIC_URL });
      const instances = [
        { ...opened, handler: instance() },
        { ...opened, handler: instance() },
      ];
      const started = await sendForTask(
        instances[0]!,
        'asker',
        { message: message('start'), configuration: { returnImmediately: true } },
        activated,
      );
      const revision = receiptsOf(started).revision;
      const continuation = (on: OpenedBureau, text: string) =>
        send(
          on,
          'asker',
          {
            message: message(text, {
              taskId: started.id,
              metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: { expectedRevision: revision } },
            }),
            configuration: { returnImmediately: true },
          },
          activated,
        );

      const sent = await Promise.all([
        continuation(instances[0]!, 'first input'),
        continuation(instances[1]!, 'second input'),
      ]);

      const refused = sent.filter((one) => one.body.error !== undefined);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.body.error.data[0].reason).toBe('STALE_REVISION');
      // The loser was refused before any effect: only the winner's input reached the session.
      expect(submitted).toHaveLength(1);
      run.release();
      await waitForCondition(async () => {
        const read = await call(opened, 'asker', 'GetTask', { id: started.id });
        return read.body.result.status.state === 'TASK_STATE_COMPLETED';
      }, 'the task never completed');
      const read = await call(opened, 'asker', 'GetTask', { id: started.id });
      const history = JSON.stringify(read.body.result.history);
      expect(['first input', 'second input'].filter((text) => history.includes(text))).toHaveLength(
        1,
      );
    });
  });

  it('give back the slot a send reserved when its effect is refused', async () => {
    const run = gated();
    await withA2A({ asker: run.generate }, async (opened) => {
      let refuse = true;
      const spying = Object.create(opened.bureau, {
        submitSessionInput: {
          value: (sessionId: string, request: unknown) =>
            refuse
              ? Promise.resolve({ outcome: 'session-terminal' })
              : opened.bureau.submitSessionInput(sessionId, request as never),
        },
      });
      const instance = {
        ...opened,
        handler: createBureauHandler(spying, {
          authentication,
          publish: ['asker'],
          publicUrl: PUBLIC_URL,
        }),
      };
      const started = await sendForTask(
        instance,
        'asker',
        { message: message('start'), configuration: { returnImmediately: true } },
        activated,
      );
      const revision = receiptsOf(started).revision;
      const continuation = (text: string) =>
        send(
          instance,
          'asker',
          {
            message: message(text, {
              taskId: started.id,
              metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: { expectedRevision: revision } },
            }),
            configuration: { returnImmediately: true },
          },
          activated,
        );

      const refused = await continuation('refused input');
      expect(refused.body.error).toBeDefined();
      refuse = false;
      const admitted = await continuation('admitted input');

      expect(admitted.body.error).toBeUndefined();
      run.release();
      await waitForCondition(async () => {
        const read = await call(opened, 'asker', 'GetTask', { id: started.id });
        return read.body.result.status.state === 'TASK_STATE_COMPLETED';
      }, 'the task never completed');
      const read = await call(opened, 'asker', 'GetTask', { id: started.id });
      const history = JSON.stringify(read.body.result.history);
      expect(history).toContain('admitted input');
      expect(history).not.toContain('refused input');
    });
  });
  it('record the form the claim recorded, over a slot another attempt reserved in another form', async () => {
    const run = gated();
    await withA2A({ asker: run.generate }, async (opened) => {
      const started = await sendForTask(
        opened,
        'asker',
        { message: message('start'), configuration: { returnImmediately: true } },
        activated,
      );
      const revision = receiptsOf(started).revision;
      const sent = message('the claimed form', {
        taskId: started.id,
        metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: { expectedRevision: revision } },
      });
      // An attempt of this message that reserved its slot in another form, then died unclaimed.
      const records = createA2ATaskRecords(opened.bureau.internals.kv!);
      await records.update(started.id, (current) => ({
        ...current,
        history: [...current.history, { ...sent, parts: [{ text: 'an abandoned form' }] }],
      }));

      const continued = await send(
        opened,
        'asker',
        { message: sent, configuration: { returnImmediately: true } },
        activated,
      );

      expect(continued.body.error).toBeUndefined();
      const stored = await records.read(started.id);
      const history = JSON.stringify(stored?.history);
      expect(history).toContain('the claimed form');
      expect(history).not.toContain('an abandoned form');
      run.release();
    });
  });
});

describe('a continuation with a deadline a year or more out', () => {
  const activated = { headers: { 'A2A-Extensions': COMMAND_RECEIPTS_EXTENSION_URI } };

  it('is admitted: the spec accepts any RFC 3339 deadline, and the mailbox’s cap is not the client’s concern', async () => {
    const run = gated();
    await withA2A({ asker: run.generate }, async (opened) => {
      const started = await sendForTask(
        opened,
        'asker',
        { message: message('start'), configuration: { returnImmediately: true } },
        activated,
      );

      const continued = await send(
        opened,
        'asker',
        {
          message: message('much later', {
            taskId: started.id,
            metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: { deadline: '2099-01-01T00:00:00Z' } },
          }),
          configuration: { returnImmediately: true },
        },
        activated,
      );

      expect(continued.body.error).toBeUndefined();
      run.release();
    });
  });
});
