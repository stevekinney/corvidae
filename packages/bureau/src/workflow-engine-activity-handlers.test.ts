/**
 * COR-1871 — a workflow document names a handler `plugin:name`; Weft only ever sees
 * `plugin__name`, so an activity registered on the engine under the mapped name runs it, and a
 * bare handler name containing `__` is refused.
 */
import { activity, type Engine } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';

const harnesses: WorkflowBureauHarness[] = [];

async function start() {
  const harness = await startWorkflowBureau({ overrides: { onDiagnostic: () => undefined } });
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

/** The composition's engine type hides `register`; it is the one Weft `Engine`. */
function registrationEngine(harness: WorkflowBureauHarness): Engine {
  return harness.bureau.durableEngine() as Engine;
}

const NEVER = { kind: 'schedule', spec: '1h' };

describe('a document step whose handler is plugin:name', () => {
  it('registers and runs an activity registered directly on the engine as plugin__name', async () => {
    const harness = await start();
    const seen: unknown[] = [];
    registrationEngine(harness).register(
      activity({
        name: 'linear__sync-issue',
        execute: async (argument: unknown) => {
          seen.push(argument);
          return { synced: true };
        },
      }),
    );
    await harness.put(
      'sync.json',
      workflowFileText('sync', {
        trigger: NEVER,
        steps: [{ kind: 'activity', handler: 'linear:sync-issue', input: { issue: 'COR-1' } }],
      }),
    );
    await harness.bureau.workflows?.refresh();
    expect(harness.bureau.workflows?.list().find((entry) => entry.id === 'sync')?.state).toBe(
      'ready',
    );

    const engine = harness.bureau.durableEngine()!;
    const handle = await engine.start('sync', { from: 'test' }, { id: 'sync-run' });
    expect(await handle.result()).toEqual({ synced: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ input: { issue: 'COR-1' }, trigger: { from: 'test' } });
  });

  it('is invalid when nothing is registered under the mapped name', async () => {
    const harness = await start();
    await harness.put(
      'orphan.json',
      workflowFileText('orphan', {
        trigger: NEVER,
        steps: [{ kind: 'activity', handler: 'linear:sync-issue' }],
      }),
    );
    await harness.bureau.workflows?.refresh();
    const listing = harness.bureau.workflows?.list().find((entry) => entry.id === 'orphan');
    expect(listing?.state).toBe('invalid');
    expect(listing?.problem?.message).toContain('steps[0].handler');
  });

  it('refuses a bare handler that contains __, even when the engine has that activity', async () => {
    const harness = await start();
    registrationEngine(harness).register(
      activity({ name: 'linear__sync-issue', execute: async () => 1 }),
    );
    await harness.put(
      'bare.json',
      workflowFileText('bare', {
        trigger: NEVER,
        steps: [{ kind: 'activity', handler: 'linear__sync-issue' }],
      }),
    );
    await harness.bureau.workflows?.refresh();
    const listing = harness.bureau.workflows?.list().find((entry) => entry.id === 'bare');
    expect(listing?.state).toBe('invalid');
    expect(listing?.problem?.message).toContain('plugin:name');
  });
});
