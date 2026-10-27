import type { GenerateContext } from '@lostgradient/operative';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deferred, openProcess, savesSessionAs, userTexts } from './test/session-input-fixtures';

/**
 * COR-1476 — a run whose session another Bureau process deletes and recreates while the run
 * starts, with the interleaving forced by a storage seam that holds one read. The run's start
 * reaches that held read only about two seconds in, on the Bureau's real timers (2,011 ms of
 * one measured run), so this is slow by nature and lives in the `test:slow` lane
 * (COR-1576). The other interleavings are in `session-input-interleaving.test.ts`.
 */

let directory: string;
let path: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'corvidae-session-input-interleaving-'));
  path = join(directory, 'bureau.sqlite');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const input = { id: 'input-x', principal: 'alice', deliveryMode: 'steer' as const, payload: 'X' };

describe('a run whose session is recreated while it starts (COR-1476)', () => {
  it('never delivers input admitted to the new incarnation: its gate is bound to the incarnation it was promoted in', async () => {
    const SESSION = 'session-recreated';
    const prompts1: string[][] = [];
    const run1Started = deferred();
    const a = await openProcess(path, async (context: GenerateContext) => {
      prompts1.push(userTexts(context.conversation));
      run1Started.resolve();
      return new Promise<never>(() => {});
    });
    const prompts2: string[][] = [];
    const run2Started = deferred();
    const release2 = deferred();
    const b = await openProcess(path, async (context: GenerateContext) => {
      prompts2.push(userTexts(context.conversation));
      if (prompts2.length === 1) {
        run2Started.resolve();
        await release2.promise;
      }
      return { content: 'done', toolCalls: [] };
    });
    const holds: Array<{ release: () => void }> = [];
    try {
      // Process A starts run 1. Its start loads the session body twice after
      // its running save committed: once for its steering promotion, once to
      // build its input gate. The second load is held.
      let bodyReads = 0;
      const gateLoad = a.seam.holdRead(
        (key) => {
          if (!key.startsWith('agent-session-v2:body:')) return false;
          bodyReads += 1;
          return bodyReads === 2;
        },
        a.seam.awaitWriteCommitted(savesSessionAs('running')),
      );
      holds.push(gateLoad);
      const creating = a.bureau.createRun({
        agentName: 'default',
        message: 'First',
        principal: 'alice',
        sessionId: SESSION,
      });
      await gateLoad.reached;

      // Process B deletes and recreates the session meanwhile, with a live run
      // of the new incarnation, and admits input to it.
      await b.bureau.contexts.delete(SESSION);
      const second = await b.bureau.createRun({
        agentName: 'default',
        message: 'Second',
        principal: 'alice',
        sessionId: SESSION,
      });
      await run2Started.promise;
      const admitted = await b.bureau.contexts.input(SESSION, input);
      expect(admitted.outcome).toBe('admitted');

      // Run 1 starts on the session it was promoted in, which is gone: it has
      // no gate, and its first step sees only its own message.
      gateLoad.release();
      await creating;
      await run1Started.promise;
      expect(prompts1).toEqual([['First']]);

      // The new incarnation's run delivers the input at its next boundary.
      release2.resolve();
      await b.bureau.waitForDurableRun(second.id);
      expect(prompts2).toEqual([['Second'], ['Second', 'X']]);
    } finally {
      release2.resolve();
      holds.forEach((hold) => hold.release());
      await a.bureau.dispose();
      await b.bureau.dispose();
    }
  });
});
