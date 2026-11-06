import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../../test';
import {
  openBureau,
  type OpenedBureau,
  OWNER,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';

async function withBureau<T>(body: (opened: OpenedBureau) => Promise<T>): Promise<T> {
  const opened = await openBureau({});
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

/** A session whose run is still going, so input sent to it waits for the run's next step. */
async function liveSession(opened: OpenedBureau) {
  const run = await opened.bureau.tasks.start('default', 'work', { principal: OWNER.alice });
  await waitForCondition(
    () => opened.bureau.tasks.detail(run.id)?.status === 'running',
    'run started',
  );
  return run;
}

const send = (opened: OpenedBureau, contextId: string): Promise<RpcBody> =>
  rpc(
    opened.handler,
    'bureau.contexts.input',
    { contextId, input: { id: 'input-1', payload: 'Then look up order 4476.' } },
    'alice-key',
  );

const retract = (
  opened: OpenedBureau,
  contextId: string,
  key: string,
  inputId = 'input-1',
): Promise<RpcBody> => rpc(opened.handler, 'bureau.contexts.retract', { contextId, inputId }, key);

describe('bureau.contexts.retract', () => {
  it('takes back a queued input, so its receipt reads canceled, and again as the same answer', async () => {
    await withBureau(async (opened) => {
      const run = await liveSession(opened);
      await send(opened, run.contextId);

      const first = await retract(opened, run.contextId, 'alice-key');
      const again = await retract(opened, run.contextId, 'alice-key');

      expect(first.error).toBeUndefined();
      expect(first.result).toMatchObject({
        outcome: 'retracted',
        receipt: { id: 'input-1', sessionId: run.contextId, state: 'canceled' },
      });
      expect(again.result).toEqual(first.result);
    });
  });

  it('answers an unknown input id as a missing input', async () => {
    await withBureau(async (opened) => {
      const run = await liveSession(opened);

      const body = await retract(opened, run.contextId, 'alice-key', 'no-such-input');

      expect(body.error?.data).toMatchObject({ httpStatus: 404, resource: 'input' });
    });
  });

  it('answers another owner’s context exactly as a missing one, and leaves the input queued', async () => {
    await withBureau(async (opened) => {
      const run = await liveSession(opened);
      await send(opened, run.contextId);

      const stranger = await retract(opened, run.contextId, 'bob-key');
      const missing = await retract(opened, 'no-such-context', 'bob-key');
      const owner = await retract(opened, run.contextId, 'alice-key');

      expect(stranger.error?.data?.httpStatus).toBe(404);
      expect(JSON.stringify(stranger).replaceAll(run.contextId, '<id>')).toBe(
        JSON.stringify(missing).replaceAll('no-such-context', '<id>'),
      );
      expect(owner.result).toMatchObject({ outcome: 'retracted' });
    });
  });
});
