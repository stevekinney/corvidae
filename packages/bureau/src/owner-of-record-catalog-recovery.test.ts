import { createAgent, stopWhen } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createTemporaryPath, removeTemporaryPath } from '@lostgradient/testing/temporary-path';

import { createBureau } from './create-bureau';
import { waitForCondition } from './test';

function nextTool() {
  return createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => 'ok',
  });
}

describe('a task recovered after a restart (COR-718)', () => {
  it('keeps its owner, anonymous:local when it was dispatched with no principal, readable through event history', async () => {
    const databasePath = createTemporaryPath('owner-of-record-catalog-recovery', '.sqlite');
    let reachedStepOne = 0;
    // A settlement that outlives the Bureau it belongs to writes into a closed database.
    const settlementFailures: string[] = [];
    const onDiagnostic = (diagnostic: { scope?: string; message: string }) => {
      if (diagnostic.scope === 'catalog-run-settlement')
        settlementFailures.push(diagnostic.message);
    };
    const first = await createBureau({
      agents: {
        echo: createAgent({
          generate: async ({ step }) => {
            if (step === 0)
              return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
            reachedStepOne += 1;
            return new Promise<never>(() => {});
          },
          toolbox: createToolbox([nextTool()]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: { type: 'sqlite', path: databasePath },
      durable: true,
      durableOwnership: { ownership: 'none' },
      onDiagnostic,
    });
    try {
      const unowned = await first.tasks.start('echo', 'unowned');
      const owned = await first.tasks.start('echo', 'owned', { principal: 'api-key:alice' });
      await waitForCondition(() => reachedStepOne >= 2, 'both runs never reached step one');
      const runIds = [unowned.id, owned.id];
      // The first process is deliberately not disposed: it stands in for a crash.

      const second = await createBureau({
        agents: {
          echo: createAgent({
            generate: async ({ step }) => ({ content: `recovered ${step}`, toolCalls: [] }),
            toolbox: createToolbox([nextTool()]),
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
        storage: { type: 'sqlite', path: databasePath },
        durable: true,
        durableOwnership: { ownership: 'none' },
        onDiagnostic,
      });
      try {
        await waitForCondition(async () => {
          const after = await second.tasks.workflows();
          return runIds.every(
            (id) => after?.items.find((item) => item.id === id)?.status === 'completed',
          );
        }, 'the recovered runs never completed');

        const owners = await Promise.all(runIds.map((id) => second.getOwner({ kind: 'run', id })));
        expect(owners.toSorted((left, right) => String(left).localeCompare(String(right)))).toEqual(
          ['anonymous:local', 'api-key:alice'],
        );
        const read = async (id: string, principal: string) => {
          const page = await second.tasks.events(id, { principal });
          return 'outcome' in page ? page.outcome : 'page';
        };
        const verdicts = await Promise.all(
          runIds.map(async (id, index) => ({
            owner: owners[index],
            asLocal: await read(id, 'anonymous:local'),
            asAlice: await read(id, 'api-key:alice'),
          })),
        );
        expect(verdicts.find((verdict) => verdict.owner === 'anonymous:local')).toMatchObject({
          asLocal: 'page',
          asAlice: 'not-found',
        });
        expect(verdicts.find((verdict) => verdict.owner === 'api-key:alice')).toMatchObject({
          asLocal: 'not-found',
          asAlice: 'page',
        });
      } finally {
        await second.dispose();
      }
    } finally {
      await first.dispose().catch(() => undefined);
      removeTemporaryPath(databasePath);
    }
    expect(settlementFailures).toEqual([]);
  });
});
