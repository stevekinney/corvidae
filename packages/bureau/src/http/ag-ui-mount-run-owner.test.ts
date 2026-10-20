/**
 * COR-1588 — one reader of a run's owner. The mount authorizes an attach by run on the owner
 * `Bureau.getOwner` reports, and the stream then refuses a held run whose own `principal` is not
 * that owner, so the two must agree for every run a Bureau holds. A hand-written agent run through
 * `bureau.run()` on the direct dispatch branch records no attribution; its owner is the one its
 * handle's liveness snapshot carries.
 */
import { EventType } from '@ag-ui/core';
import { createAgent, type RunnableAgent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { createBureau } from '../create-bureau.ts';
import { as, attachRunRequest, authentication } from './ag-ui-fixtures.test-support.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import { FrameReader, readAgUiStream } from './ag-ui-stream.test-support.ts';
import { createMemoryAssetStorage } from '../assets/storage';

describe('attaching by run to a bureau.run() run of a hand-written agent', () => {
  it('streams it to its owner, and answers another owner as a missing run', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generate = async () => {
      await gate;
      return { content: 'Done.', toolCalls: [] };
    };
    // No `OPERATIVE_RESOLVE_RUN_OPTIONS`: a durable Bureau falls back to the direct branch.
    const handWritten: RunnableAgent = {
      name: 'plain',
      hasOutput: false,
      run: (input, context) => createAgent({ generate }).run(input, context),
    };
    const bureau = await createBureau({
      assets: { storage: createMemoryAssetStorage() },
      id: 'ag-ui-run-owner',
      agents: { plain: handWritten },
      storage: { type: 'memory' },
      durableExecution: true,
    });
    try {
      const handler = createBureauHandler(bureau, { authentication, publish: [], agUi: {} });
      const run = bureau.run('plain', 'hi', { principal: 'api-key:alice' });
      expect(await bureau.getOwner({ kind: 'run', id: run.id })).toBe('api-key:alice');

      const stranger = await readAgUiStream(await handler(attachRunRequest(run.id, as('bob-key'))));
      const owner = new FrameReader(await handler(attachRunRequest(run.id, as('alice-key'))));
      try {
        // The owner's stream opens. Whether it ends with the run is a matter for the stream.
        const first = await owner.next();
        expect(first?.event).toMatchObject({ type: EventType.RUN_STARTED });
      } finally {
        await owner.cancel();
      }

      expect(stranger).toHaveLength(1);
      expect(stranger[0]!.event).toMatchObject({ code: 'RUN_NOT_FOUND' });
    } finally {
      release();
      await bureau.dispose();
    }
  });
});
