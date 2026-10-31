/**
 * COR-1874 — a workflow file can use an activity and a trigger kind that a plugin contributes
 * through the versioned catalog. The file names them `plugin:name` with no version; the revision
 * Bureau registers pins the activity version that was loaded.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { PluginActivity } from '@lostgradient/interborough-plugin';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';

import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';
import {
  activityAnswer,
  contributionCatalog,
  createTickerController,
  type TickerController,
} from './testing/workflow-contributions.test-support';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';
import { createVersionedCatalog } from './versioned-catalog';
import { createWorkflowContributions } from './workflow-contributions';
import { WorkflowInputInvalidError } from './workflow-schema';

const harnesses: WorkflowBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
});

async function start(
  options: { version?: string; ticker?: TickerController; activity?: PluginActivity } = {},
) {
  const harness = await startWorkflowBureau({
    overrides: {
      contributionCatalog: contributionCatalog({
        activityVersion: options.version ?? '1',
        ticker: options.ticker,
        activity: options.activity,
      }),
      onDiagnostic: () => undefined,
    },
  });
  harnesses.push(harness);
  return harness;
}

const ticking = (overrides: Record<string, unknown> = {}) => ({
  trigger: { kind: 'x:ticker', channel: 'alerts' },
  steps: [{ kind: 'activity', handler: 'x:y', input: 'hello' }],
  ...overrides,
});

async function listing(harness: WorkflowBureauHarness, id: string) {
  await harness.bureau.workflows?.refresh();
  return harness.bureau.workflows?.list().find((entry) => entry.id === id);
}

async function stateOf(harness: WorkflowBureauHarness, id: string) {
  const file = await listing(harness, id);
  return file?.state;
}

async function versionOf(harness: WorkflowBureauHarness, id: string) {
  const file = await listing(harness, id);
  return file?.version;
}

async function firstRunStatus(harness: WorkflowBureauHarness, id: string) {
  const runs = await runsOf(harness, id);
  return runs[0]?.status;
}

/** The first run's status once it has ended. */
async function settledStatus(harness: WorkflowBureauHarness, id: string) {
  await waitUntil(
    async () => {
      const status = await firstRunStatus(harness, id);
      // `suspended` is a retry waiting out its backoff, not an end.
      return status === 'completed' || status === 'failed' || status === 'cancelled';
    },
    { message: 'the run to settle' },
  );
  return firstRunStatus(harness, id);
}

async function runCount(harness: WorkflowBureauHarness, id: string) {
  const runs = await runsOf(harness, id);
  return runs.length;
}

async function runsOf(harness: WorkflowBureauHarness, id: string) {
  const page = await harness.bureau.workflows?.listRuns({ workflow: id, limit: 10, offset: 0 });
  return page?.runs ?? [];
}

describe('a workflow file that uses a contributed activity and trigger kind', () => {
  it('registers, and starts an instance when the trigger fires', async () => {
    const ticker = createTickerController();
    const harness = await start({ ticker });
    await harness.put('pipeline.json', workflowFileText('pipeline', ticking()));

    expect(await stateOf(harness, 'pipeline')).toBe('ready');
    expect(ticker.contexts).toHaveLength(1);
    expect(ticker.contexts[0]?.configuration).toEqual({ channel: 'alerts' });

    await ticker.fire({ issue: 'COR-1' });
    await waitUntil(async () => (await firstRunStatus(harness, 'pipeline')) === 'completed', {
      message: 'the fired instance to complete',
    });
    const [run] = await runsOf(harness, 'pipeline');
    const detail = await harness.bureau.workflows?.getRun(run!.id);
    expect(detail?.trigger).toEqual({ kind: 'x:ticker', payload: { issue: 'COR-1' } });
    expect(detail?.result).toBe(activityAnswer('1', 'hello'));
  });

  it('starts an instance for a trigger that fires while it is still starting', async () => {
    const ticker = createTickerController();
    ticker.fireOnStart = { early: true };
    const harness = await start({ ticker });
    await harness.put('pipeline.json', workflowFileText('pipeline', ticking()));
    await listing(harness, 'pipeline');
    await waitUntil(async () => (await firstRunStatus(harness, 'pipeline')) === 'completed', {
      message: 'the instance the starting trigger fired',
    });
  });

  it('retries a contributed activity by the retry policy its definition declares', async () => {
    let attempts = 0;
    const ticker = createTickerController();
    const harness = await start({
      ticker,
      activity: {
        name: 'y',
        retry: { maxAttempts: 3, initialBackoff: 1, backoffMultiplier: 1, maxBackoff: 1 },
        execute: () => {
          attempts += 1;
          if (attempts < 3) throw new Error(`attempt ${attempts} failed`);
          return `succeeded after ${attempts}`;
        },
      },
    });
    await harness.put('pipeline.json', workflowFileText('pipeline', ticking()));
    await listing(harness, 'pipeline');

    await ticker.fire(null);
    expect(await settledStatus(harness, 'pipeline')).toBe('completed');
    const [run] = await runsOf(harness, 'pipeline');
    const detail = await harness.bureau.workflows?.getRun(run!.id);
    expect(detail?.result).toBe('succeeded after 3');
    expect(attempts).toBe(3);
  });

  it('bounds a contributed activity by the timeout its definition declares, and aborts its signal', async () => {
    let sawAbort = false;
    const ticker = createTickerController();
    const harness = await start({
      ticker,
      activity: {
        name: 'y',
        timeout: 50,
        execute: (_argument: unknown, context?: { signal: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            context?.signal.addEventListener('abort', () => {
              sawAbort = true;
              reject(new Error('aborted'));
            });
          }),
      },
    });
    await harness.put('pipeline.json', workflowFileText('pipeline', ticking()));
    await listing(harness, 'pipeline');

    await ticker.fire(null);
    expect(await settledStatus(harness, 'pipeline')).toBe('failed');
    const [run] = await runsOf(harness, 'pipeline');
    expect(JSON.stringify(await harness.bureau.workflows?.getRun(run!.id))).toContain(
      'per-attempt timeout of 50ms',
    );
    expect(sawAbort).toBe(true);
  });

  it('pins the loaded version of the activity in the revision it registers', async () => {
    const harness = await start({ ticker: createTickerController() });
    await harness.put('pipeline.json', workflowFileText('pipeline', ticking()));
    const file = await listing(harness, 'pipeline');

    const kv = harness.bureau.internals.kv!;
    const [key] = await kv.list('bureau-workflow-snapshot:v1:pipeline:');
    const stored = JSON.parse((await kv.get(key!)) ?? '{}');
    expect(stored.workflowVersion).toBe(file?.version);
    expect(stored.document.activityVersions).toEqual({ 'x:y': '1' });
    expect(stored.document.steps[0].version).toBeUndefined();
  });

  it('is another revision when the activity is loaded at another version', async () => {
    const first = await start({ ticker: createTickerController(), version: '1' });
    await first.put('pipeline.json', workflowFileText('pipeline', ticking()));
    const second = await start({ ticker: createTickerController(), version: '2' });
    await second.put('pipeline.json', workflowFileText('pipeline', ticking()));

    expect(await versionOf(first, 'pipeline')).not.toBe(await versionOf(second, 'pipeline'));
  });

  it('judges the payload against the inputSchema, not the envelope', async () => {
    const ticker = createTickerController();
    const harness = await start({ ticker });
    await harness.put(
      'pipeline.json',
      workflowFileText(
        'pipeline',
        ticking({
          inputSchema: {
            type: 'object',
            required: ['issue'],
            properties: { issue: { type: 'string' } },
          },
        }),
      ),
    );
    expect(await stateOf(harness, 'pipeline')).toBe('ready');

    expect(await rejectionOf(ticker.fire({ issue: 3 }))).toBeInstanceOf(WorkflowInputInvalidError);
    expect(await runsOf(harness, 'pipeline')).toEqual([]);
    await ticker.fire({ issue: 'COR-2' });
    await waitUntil(async () => (await runCount(harness, 'pipeline')) === 1, {
      message: 'the accepted payload to start an instance',
    });
  });

  it('starts the revision a changed file registers when a trigger fires while the change is applying', async () => {
    const ticker = createTickerController();
    const harness = await start({ ticker });
    await harness.put('pipeline.json', workflowFileText('pipeline', ticking()));
    await listing(harness, 'pipeline');
    const before = await versionOf(harness, 'pipeline');
    const oldTrigger = ticker.contexts[0]!;

    // Another file's trigger is still starting, so the apply it belongs to has not finished.
    const release = ticker.hold('blocked');
    await harness.put(
      'other.json',
      workflowFileText('other', ticking({ trigger: { kind: 'x:ticker', channel: 'blocked' } })),
    );
    void harness.bureau.workflows?.refresh();
    await waitUntil(() => ticker.hasStarted('blocked'), { message: 'the held trigger to start' });

    // The pipeline's file changes: the catalog has it now, but its revision is not registered.
    await harness.put(
      'pipeline.json',
      workflowFileText(
        'pipeline',
        ticking({ steps: [{ kind: 'activity', handler: 'x:y', input: 'changed' }] }),
      ),
    );
    void harness.bureau.workflows?.refresh();
    await waitUntil(
      () =>
        harness.bureau.workflows?.list().find((entry) => entry.id === 'pipeline')?.version !==
        before,
      {
        message: 'the catalog to hold the changed file',
      },
    );

    const fired = oldTrigger.fire({ issue: 'COR-3' });
    release();
    await fired;

    await waitUntil(async () => (await firstRunStatus(harness, 'pipeline')) === 'completed', {
      message: 'the fired instance to complete',
    });
    const [run] = await runsOf(harness, 'pipeline');
    const detail = await harness.bureau.workflows?.getRun(run!.id);
    expect(detail?.result).toBe(activityAnswer('1', 'changed'));
  });

  it('stops the trigger when the file is paused, and a fire after that starts nothing', async () => {
    const ticker = createTickerController();
    const harness = await start({ ticker });
    await harness.put('pipeline.json', workflowFileText('pipeline', ticking()));
    await listing(harness, 'pipeline');
    expect(ticker.stopped).toBe(0);

    await harness.put('pipeline.json', workflowFileText('pipeline', ticking({ paused: true })));
    await listing(harness, 'pipeline');
    expect(ticker.stopped).toBe(1);
    expect(ticker.contexts[0]?.signal.aborted).toBe(true);
    await ticker.contexts[0]!.fire('late');
    expect(await runsOf(harness, 'pipeline')).toEqual([]);
  });

  it('restarts the trigger when its configuration changes, and stops it when the file goes', async () => {
    const ticker = createTickerController();
    const harness = await start({ ticker });
    await harness.put('pipeline.json', workflowFileText('pipeline', ticking()));
    await listing(harness, 'pipeline');
    await harness.put(
      'pipeline.json',
      workflowFileText('pipeline', ticking({ trigger: { kind: 'x:ticker', channel: 'other' } })),
    );
    await listing(harness, 'pipeline');
    expect(ticker.stopped).toBe(1);
    expect(ticker.contexts.map((context) => context.configuration)).toEqual([
      { channel: 'alerts' },
      { channel: 'other' },
    ]);

    await harness.bureau.workflows?.delete('pipeline', {
      expectedHash: (await harness.bureau.workflows.get('pipeline'))!.hash!,
    });
    expect(ticker.stopped).toBe(2);
  });

  it('stops every trigger when the Bureau closes', async () => {
    const ticker = createTickerController();
    const harness = await start({ ticker });
    await harness.put('pipeline.json', workflowFileText('pipeline', ticking()));
    await listing(harness, 'pipeline');
    await harness.bureau.dispose();
    expect(ticker.stopped).toBe(1);
  });

  it('is invalid when the trigger configuration does not satisfy its kind', async () => {
    const harness = await start({ ticker: createTickerController() });
    await harness.put(
      'pipeline.json',
      workflowFileText('pipeline', ticking({ trigger: { kind: 'x:ticker', channel: 3 } })),
    );
    const file = await listing(harness, 'pipeline');
    expect(file?.state).toBe('invalid');
    expect(file?.problem?.message).toContain('"channel"');
  });

  it('is invalid when the trigger kind is not contributed', async () => {
    const harness = await start();
    await harness.put('pipeline.json', workflowFileText('pipeline', ticking()));
    const file = await listing(harness, 'pipeline');
    expect(file?.state).toBe('invalid');
    expect(file?.problem?.message).toContain('trigger kind "x:ticker" is not registered');
  });

  it('is invalid when the file pins an activity version itself', async () => {
    const harness = await start({ ticker: createTickerController() });
    await harness.put(
      'pipeline.json',
      workflowFileText('pipeline', ticking({ activityVersions: { 'x:y': '1' } })),
    );
    const file = await listing(harness, 'pipeline');
    expect(file?.state).toBe('invalid');
    expect(file?.problem?.message).toContain('does not pin activity versions');
  });
});

describe('the contributions a catalog holds', () => {
  it('refuses a name loaded at two versions, because a file names it without one', () => {
    const catalog = createVersionedCatalog();
    for (const version of ['1', '2']) {
      catalog.register({
        kind: 'activity',
        name: 'x:y',
        version,
        value: { name: 'y', execute: () => version },
        source: { name: 'x', version },
      });
    }
    expect(() => createWorkflowContributions(catalog)).toThrow('loaded at versions 1 and 2');
  });

  it('refuses a name that is not plugin:name', () => {
    const catalog = createVersionedCatalog();
    catalog.register({
      kind: 'trigger-kind',
      name: 'ticker',
      version: '1',
      value: {},
      source: { name: 'x', version: '1' },
    });
    expect(() => createWorkflowContributions(catalog)).toThrow('is not a plugin:name identifier');
  });

  it('refuses an entry that is not an activity or a trigger kind', () => {
    const activities = createVersionedCatalog();
    activities.register({
      kind: 'activity',
      name: 'x:y',
      version: '1',
      value: { name: 'y' },
      source: { name: 'x', version: '1' },
    });
    expect(() => createWorkflowContributions(activities)).toThrow('has no execute function');
    const kinds = createVersionedCatalog();
    kinds.register({
      kind: 'trigger-kind',
      name: 'x:ticker',
      version: '1',
      value: { name: 'ticker' },
      source: { name: 'x', version: '1' },
    });
    expect(() => createWorkflowContributions(kinds)).toThrow('needs a configuration schema');
  });

  it('resolves exactly the loaded version, and says why otherwise', () => {
    const contributions = createWorkflowContributions(
      contributionCatalog({ activityVersion: '2' }),
    );
    expect(contributions.resolveActivity('x:y', '2').ok).toBe(true);
    expect(contributions.resolveActivity('x:y', '1')).toMatchObject({
      ok: false,
      reason: 'version-mismatch',
      availableVersions: ['2'],
    });
    expect(contributions.resolveActivity('x:z', '2')).toMatchObject({
      ok: false,
      reason: 'missing',
      availableVersions: [],
    });
  });
});
