/**
 * The `replayComplete` ping of `bureau.tasks.events` follows every event the stream replays: the
 * shared SSE contract (`packages/weft/src/server/asyncapi-channels.ts`) puts the marker after the
 * already-recorded events, so a client that treats it as "caught up" has the replay in hand.
 */
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../../test';
import {
  answering,
  openBureau,
  OWNER,
  readWireBlocks,
  subscribeRequest,
} from './management-fixtures.test-support.ts';

describe('bureau.tasks.events replay marker', () => {
  it('sends the replayComplete ping after the snapshot and every replayed event of a finished task', async () => {
    const opened = await openBureau({ durableHistory: true, generate: answering('the answer') });
    try {
      const run = await opened.bureau.tasks.start('default', 'go', { principal: OWNER.alice });
      await waitForCondition(
        () => opened.bureau.tasks.detail(run.id)?.status === 'completed',
        'finish',
      );
      await waitForCondition(async () => {
        const page = await opened.bureau.tasks.events(run.id);
        return 'events' in page && page.events.some((event) => event.kind === 'run.completed');
      }, 'run.completed never reached the history');

      const blocks = await readWireBlocks(
        await opened.handler(
          subscribeRequest('bureau.tasks.events', { taskId: run.id }, 'alice-key'),
        ),
      );

      const marker = blocks.findIndex(
        (block) => block.event === 'ping' && block.data.replayComplete === true,
      );
      expect(marker).toBeGreaterThan(-1);
      const events = blocks.flatMap((block, index) =>
        block.event.startsWith('task.') ? [index] : [],
      );
      expect(events.length).toBeGreaterThan(0);
      // A finished task replays everything and ends: no event may follow the marker.
      expect(Math.max(...events)).toBeLessThan(marker);
    } finally {
      await opened.dispose();
    }
  });
});
