/**
 * COR-1710 — `sessionInput.*` are read by admission, not fixed when the Bureau was built. The
 * principal limit is read at every admission; the session limit is fixed by the Weft mailbox for
 * the life of one session incarnation, so it applies to a session started after the change.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent } from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from '../agent-catalog.ts';
import { createBureau } from '../create-bureau.ts';
import type { Bureau } from '../types.ts';

async function open(): Promise<Bureau<AgentDefinitions>> {
  return createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: () => new Promise<never>(() => {}),
        toolbox: createToolbox([]),
      }),
    },
    runtime: createManualRuntimeServices({ origin: '2026-10-13T00:00:00.000Z' }),
    storage: { type: 'memory' },
    durable: true,
  });
}

/** Starts a task that never settles and returns its context. */
async function runningContext(bureau: Bureau<AgentDefinitions>): Promise<string> {
  const run = await bureau.tasks.start('default', 'hold open', { principal: 'alice' });
  await waitUntil(
    async () => {
      const context = await bureau.contexts.get(run.contextId);
      return context?.metadata['lastRunStatus'] === 'running';
    },
    { message: 'the context to run' },
  );
  return run.contextId;
}

async function change(bureau: Bureau<AgentDefinitions>, patch: Record<string, unknown>) {
  const { revision } = await bureau.settings.get();
  expect(await bureau.settings.update(patch, { expectedRevision: revision })).toMatchObject({
    outcome: 'applied',
  });
}

const input = (id: string, principal = 'alice') =>
  ({ id, principal, deliveryMode: 'queue', payload: id }) as const;

describe('sessionInput.principalBacklogLimit', () => {
  it('the next admission is refused at the new limit', async () => {
    const bureau = await open();
    try {
      const contextId = await runningContext(bureau);
      const first = await bureau.contexts.input(contextId, input('one'));
      expect(first.outcome).toBe('admitted');

      await change(bureau, { 'sessionInput.principalBacklogLimit': 1 });
      expect(await bureau.contexts.input(contextId, input('two'))).toMatchObject({
        outcome: 'backlog-exhausted',
        scope: 'principal',
        limit: 1,
      });
    } finally {
      await bureau.dispose();
    }
  });
});

describe('sessionInput.sessionBacklogLimit', () => {
  it('a session started after the change admits against the new limit', async () => {
    const bureau = await open();
    try {
      await change(bureau, { 'sessionInput.sessionBacklogLimit': 1 });
      const contextId = await runningContext(bureau);
      const first = await bureau.contexts.input(contextId, input('one'));
      expect(first.outcome).toBe('admitted');
      expect(await bureau.contexts.input(contextId, input('two'))).toMatchObject({
        outcome: 'backlog-exhausted',
        scope: 'session',
        limit: 1,
      });
    } finally {
      await bureau.dispose();
    }
  });
});
