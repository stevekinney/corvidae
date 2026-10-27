/**
 * COR-1706. `bureau.contexts` serves the `session` owner kind of the durable event history, so the
 * events a context records stay readable once the flat session members go, and the run owner's
 * history is still `eventHistory`'s.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, type DurableEventEnvelope } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from '../agent-catalog.ts';
import { createBureau } from '../create-bureau.ts';
import { createSqliteStorageFixture } from '../test/storage-fixtures.ts';
import { finishes } from '../test/task-record-crash-agent.ts';
import type { Bureau } from '../types.ts';

const bureaus: Bureau<AgentDefinitions>[] = [];
const fixtures: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0).toReversed()) await bureau.dispose();
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

async function open(durable: boolean): Promise<Bureau<AgentDefinitions>> {
  const fixture = createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() });
  fixtures.push(fixture);
  const bureau = await createBureau<AgentDefinitions>({
    agents: { default: createAgent({ generate: finishes, toolbox: createToolbox([]) }) },
    storage: durable ? fixture.configuration : { type: 'memory' },
    durable,
    ...(durable ? { durableOwnership: { ownership: 'none' as const } } : {}),
  });
  bureaus.push(bureau);
  await bureau.waitForRecovery?.();
  return bureau;
}

/** Waits until the context's history holds a saved session, then resolves what it has seen. */
async function untilSaved(bureau: Bureau<AgentDefinitions>, contextId: string) {
  const seen: DurableEventEnvelope[] = [];
  const saved = Promise.withResolvers<void>();
  const subscription = bureau.contexts.subscribeEvents(contextId, (event) => {
    seen.push(event);
    if (event.kind === 'session.saved') saved.resolve();
  });
  try {
    await saved.promise;
  } finally {
    subscription.unsubscribe();
  }
  return seen;
}

describe('bureau.contexts.events and subscribeEvents', () => {
  it('serve the session owner of the durable event history', async () => {
    const bureau = await open(true);
    const run = await bureau.tasks.start('default', 'hello', { principal: 'alice' });

    const seen = await untilSaved(bureau, run.contextId);
    const viaNamespace = await bureau.contexts.events(run.contextId);
    const viaOwner = await bureau.contexts.events(run.contextId);

    expect(seen.map((event) => event.kind)).toContain('session.created');
    expect(viaNamespace).toEqual(viaOwner);
    if (!('events' in viaNamespace)) throw new Error('expected a page');
    expect(viaNamespace.events.map((event) => event.kind)).toContain('session.saved');
  });

  it('do not read the run owner, whose history stays on eventHistory', async () => {
    const bureau = await open(true);
    const run = await bureau.tasks.start('default', 'hello', { principal: 'alice' });
    await untilSaved(bureau, run.contextId);

    const viaRunId = await bureau.contexts.events(run.id);
    const runHistory = await bureau.tasks.events(run.id);

    expect(viaRunId).not.toEqual(runHistory);
  });

  it('answer an unsupported capability on a Bureau with no persistent storage', async () => {
    const bureau = await open(false);

    expect(await bureau.contexts.events('context-1')).toEqual({
      outcome: 'unsupported-capability',
      reason: 'no-persistent-storage',
    });
    expect(bureau.contexts.subscribeEvents('context-1', () => {}).closed).toBe(true);
  });
});
