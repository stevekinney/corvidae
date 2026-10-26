/**
 * What a continuation of a task is fenced to (COR-1661): the session incarnation it was checked
 * against, and the revision it named.
 */
import type { GenerateFunction } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../test';
import { COMMAND_RECEIPTS_EXTENSION_URI } from './a2a-command-receipts.ts';
import { call, type Json, message, send, sendForTask, withA2A } from './a2a-mount.test-support.ts';
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
});
