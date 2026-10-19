import { describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine/index.ts';
import { listWorkflowSources } from '../core/engine/source-listing.ts';
import {
  WorkflowRevisionActivatedEvent,
  WorkflowRevisionDrainingEvent,
  WorkflowRevisionInstalledEvent,
} from '../core/events/catalog-events.ts';
import { workflow } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { waitForCondition } from '../testing/fake-timers.test-support.ts';
import { throwingRejectionOf } from '../testing/promise-outcome.test-support.ts';
import { WorkflowDocumentValidationError, type DocumentWorkflowHost } from './document.ts';
import { registerWorkflowDocuments } from './register.ts';

const handlerCalls: string[] = [];
const traces: { input: unknown; trigger: unknown; previous: unknown }[] = [];
const identities: { workflowId: string; step: number }[] = [];
let hangIdentify = false;

const host: DocumentWorkflowHost = {
  activities: {
    greet: ({ input, trigger, previous }) => {
      handlerCalls.push('greet');
      return { greeting: input, trigger, previous };
    },
    shout: ({ input, previous }) => `${JSON.stringify(input)}:${JSON.stringify(previous)}`,
    explode: () => {
      handlerCalls.push('explode');
      throw new Error('handler exploded');
    },
    version: ({ input }) => input,
    'payments.charge': () => null,
    identify: ({ workflowId, step }) => {
      identities.push({ workflowId, step });
      return hangIdentify ? new Promise(() => undefined) : { workflowId, step };
    },
    trace: ({ input, trigger, previous }) => {
      traces.push({ input, trigger, previous });
      return input;
    },
  },
  triggerKinds: { manual: () => undefined },
};

function createDocument(
  name: string,
  steps: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return { name, trigger: { kind: 'manual' }, steps };
}

async function waitForParkedOnSignal(engine: Engine, workflowId: string): Promise<void> {
  await waitForCondition(
    async () => {
      const timeline = await engine.getTimeline(workflowId);
      return timeline.some((entry) => entry.operationType === 'wait-signal');
    },
    { label: `${workflowId} parked on its signal` },
  );
}

describe('registerWorkflowDocuments()', () => {
  it('registers two documents as two workflow types and runs each', async () => {
    const documentA = createDocument('document-a', [
      { kind: 'activity', handler: 'greet', input: 'hello' },
      { kind: 'await-signal', signal: 'approve' },
      { kind: 'activity', handler: 'shout', input: 'done' },
    ]);
    const documentB = createDocument('document-b', [
      { kind: 'activity', handler: 'greet', input: 'second' },
    ]);

    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    const registered = await registerWorkflowDocuments(engine, host, {
      active: [documentA, documentB],
    });

    expect(registered.map((entry) => entry.name)).toEqual(['document-a', 'document-b']);

    const runA = await engine.start('document-a', { fire: 1 }, { id: 'run-a' });
    const runB = await engine.start('document-b', { fire: 2 }, { id: 'run-b' });

    expect(await runB.result()).toEqual({
      greeting: 'second',
      trigger: { fire: 2 },
      previous: null,
    });
    await runA.signal('approve', { by: 'owner' });
    expect(await runA.result()).toBe('"done":{"by":"owner"}');
  });

  it('hands each step the prior activity output, the signal payload, null after a sleep, and null first', async () => {
    traces.length = 0;
    const document = createDocument('previous-values', [
      { kind: 'activity', handler: 'trace', input: 'a' },
      { kind: 'activity', handler: 'trace', input: 'b' },
      { kind: 'await-signal', signal: 'go' },
      { kind: 'activity', handler: 'trace', input: 'c' },
      { kind: 'sleep', duration: 1 },
      { kind: 'activity', handler: 'trace', input: 'd' },
    ]);
    // `Engine.create` starts the scheduler that fires the sleep; `new Engine` does not.
    await using engine = await Engine.create({ storage: new MemoryStorage() });
    await registerWorkflowDocuments(engine, host, { active: [document] });

    const run = await engine.start('previous-values', 'fire', { id: 'previous-run' });
    await run.signal('go', { payload: true });

    expect(await run.result()).toBe('d');
    expect(traces).toEqual([
      { input: 'a', trigger: 'fire', previous: null },
      { input: 'b', trigger: 'fire', previous: 'a' },
      { input: 'c', trigger: 'fire', previous: { payload: true } },
      { input: 'd', trigger: 'fire', previous: null },
    ]);
  });

  it('fails the instance with the handler error and does not retry the step', async () => {
    handlerCalls.length = 0;
    const document = createDocument('failing-document', [{ kind: 'activity', handler: 'explode' }]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, { active: [document] });

    const run = await engine.start('failing-document', null, { id: 'failing-run' });
    expect(await throwingRejectionOf(run.result())).toThrow('handler exploded');
    expect(handlerCalls).toEqual(['explode']);
    const failed = await engine.get('failing-run');
    expect(failed?.status).toBe('failed');
  });

  it("carries the document version in the contract's workflowVersion and lists its activity steps", async () => {
    const document = createDocument('contract-document', [
      { kind: 'activity', handler: 'greet' },
      { kind: 'activity', handler: 'shout', input: 'x' },
      { kind: 'activity', handler: 'greet' },
    ]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    const [registered] = await registerWorkflowDocuments(engine, host, { active: [document] });

    const record = await engine.workflows.getRevision('contract-document', registered!.revision);

    expect(registered!.workflowVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record?.manifest.workflowVersion).toBe(registered!.workflowVersion);
    expect(record?.manifest.contract.workflowVersion).toBe(registered!.workflowVersion);
    expect(Object.keys(record?.manifest.contract.activities ?? {}).toSorted()).toEqual([
      'greet',
      'shout',
    ]);
  });

  it('declares the signals a document awaits in its contract, and none when it awaits none', async () => {
    const awaiting = createDocument('awaiting-document', [
      { kind: 'await-signal', signal: 'approve' },
      { kind: 'activity', handler: 'greet' },
      { kind: 'await-signal', signal: 'approve' },
      { kind: 'await-signal', signal: 'cancel' },
    ]);
    const plain = createDocument('plain-document', [{ kind: 'activity', handler: 'greet' }]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    const [withSignals, withoutSignals] = await registerWorkflowDocuments(engine, host, {
      active: [awaiting, plain],
    });

    const awaitingRecord = await engine.workflows.getRevision(
      'awaiting-document',
      withSignals!.revision,
    );
    const plainRecord = await engine.workflows.getRevision(
      'plain-document',
      withoutSignals!.revision,
    );

    expect(Object.keys(awaitingRecord?.manifest.contract.signals ?? {}).toSorted()).toEqual([
      'approve',
      'cancel',
    ]);
    expect(plainRecord?.manifest.contract.signals).toBeUndefined();
  });

  it('gives identical content the same revision and a one-step change a new one', async () => {
    const steps = [
      { kind: 'activity', handler: 'shout', input: 'a' },
      { kind: 'await-signal', signal: 'go' },
    ];
    const registerOn = async (candidate: Record<string, unknown>) => {
      await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
      const [registered] = await registerWorkflowDocuments(engine, host, { active: [candidate] });
      return registered!;
    };

    const first = await registerOn(createDocument('revisions', steps));
    const again = await registerOn(createDocument('revisions', structuredClone(steps)));
    const changed = await registerOn(
      createDocument('revisions', [{ kind: 'activity', handler: 'shout', input: 'b' }, steps[1]!]),
    );

    expect(again).toEqual(first);
    expect(changed.workflowVersion).not.toBe(first.workflowVersion);
    expect(changed.revision).not.toBe(first.revision);
  });

  it('keeps a running instance on the revision it started on', async () => {
    const version1 = createDocument('versioned', [
      { kind: 'await-signal', signal: 'go' },
      { kind: 'activity', handler: 'version', input: 'one' },
    ]);
    const version2 = createDocument('versioned', [
      { kind: 'await-signal', signal: 'go' },
      { kind: 'activity', handler: 'version', input: 'two' },
    ]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, { active: [version1] });
    const oldRun = await engine.start('versioned', null, { id: 'old-run' });

    const [registered] = await registerWorkflowDocuments(engine, host, {
      active: [version2],
      retained: [version1],
    });
    const newRun = await engine.start('versioned', null, { id: 'new-run' });
    await newRun.signal('go', null);
    await oldRun.signal('go', null);

    expect(await newRun.result()).toBe('two');
    expect(await oldRun.result()).toBe('one');
    const active = await engine.workflows.getActive('versioned');
    expect(active?.revision).toBe(registered!.revision);
  });

  it('announces each document revision as installed and activated, and the displaced one as draining', async () => {
    const version1 = createDocument('announced', [
      { kind: 'activity', handler: 'greet', input: 1 },
    ]);
    const version2 = createDocument('announced', [
      { kind: 'activity', handler: 'greet', input: 2 },
    ]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    const seen: string[] = [];
    engine.addEventListener(WorkflowRevisionInstalledEvent.type, () => seen.push('installed'));
    engine.addEventListener(WorkflowRevisionDrainingEvent.type, () => seen.push('draining'));
    engine.addEventListener(WorkflowRevisionActivatedEvent.type, () => seen.push('activated'));

    await registerWorkflowDocuments(engine, host, { active: [version1] });
    await registerWorkflowDocuments(engine, host, { active: [version2], retained: [version1] });

    expect(seen).toEqual(['installed', 'activated', 'installed', 'draining', 'activated']);
  });

  it('is idempotent for a document that is already registered', async () => {
    const document = createDocument('repeated', [{ kind: 'activity', handler: 'greet' }]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });

    const first = await registerWorkflowDocuments(engine, host, { active: [document] });
    const second = await registerWorkflowDocuments(engine, host, { active: [document] });

    expect(second).toEqual(first);
  });

  it('rejects an invalid document before registering anything', async () => {
    const valid = createDocument('valid-document', [{ kind: 'activity', handler: 'greet' }]);
    const invalid = createDocument('invalid-document', [{ kind: 'activity', handler: 'missing' }]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });

    expect(
      await throwingRejectionOf(
        registerWorkflowDocuments(engine, host, { active: [valid, invalid] }),
      ),
    ).toThrow(WorkflowDocumentValidationError);
    expect(listWorkflowSources(engine)).toEqual([]);
  });

  it('rejects a handler that is not a wire-safe activity name before registering anything', async () => {
    const valid = createDocument('valid-document', [{ kind: 'activity', handler: 'greet' }]);
    const dotted = createDocument('dotted-document', [
      { kind: 'activity', handler: 'payments.charge' },
    ]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });

    expect(
      await throwingRejectionOf(
        registerWorkflowDocuments(engine, host, { active: [valid, dotted] }),
      ),
    ).toThrow(WorkflowDocumentValidationError);
    expect(listWorkflowSources(engine)).toEqual([]);
  });

  it('rejects a document named like a code workflow before registering anything', async () => {
    const valid = createDocument('valid-document', [{ kind: 'activity', handler: 'greet' }]);
    const clashing = createDocument('code-workflow', [{ kind: 'activity', handler: 'greet' }]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    engine.register(
      workflow({ name: 'code-workflow' }).execute(async function* () {
        return 'code';
      }),
    );

    for (const documents of [
      { active: [valid, clashing] },
      { active: [valid], retained: [clashing] },
    ]) {
      expect(await throwingRejectionOf(registerWorkflowDocuments(engine, host, documents))).toThrow(
        WorkflowDocumentValidationError,
      );
    }
    expect(listWorkflowSources(engine)).toEqual([]);
  });

  it('rejects two active documents for one name', async () => {
    const first = createDocument('twice', [{ kind: 'activity', handler: 'greet' }]);
    const second = createDocument('twice', [{ kind: 'activity', handler: 'shout' }]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });

    expect(
      await throwingRejectionOf(
        registerWorkflowDocuments(engine, host, { active: [first, second] }),
      ),
    ).toThrow(WorkflowDocumentValidationError);
    expect(listWorkflowSources(engine)).toEqual([]);
  });
});

describe('a Weft schedule targeting a document type', () => {
  it('fires an instance with the fire as its trigger', async () => {
    const document = createDocument('scheduled-document', [
      { kind: 'activity', handler: 'greet', input: 'tick' },
    ]);
    const clock = { now: Date.UTC(2026, 0, 1) };
    await using engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => clock.now,
    });
    await registerWorkflowDocuments(engine, host, { active: [document] });

    const fire = { source: 'schedule', occurrence: 1 };
    const schedule = await engine.schedule(
      'scheduled-document',
      fire,
      { every: '1m' },
      { id: 'tick' },
    );
    const summary = await schedule.describe();
    const nextFireAt = summary.nextFireAt!;
    clock.now = nextFireAt;
    await engine.scheduler.tick(clock.now);

    await waitForCondition(
      async () => {
        const page = await engine.list({ type: 'scheduled-document' });
        return page.items.some((state) => state.status === 'completed');
      },
      { label: 'scheduled document instance to complete' },
    );
    const { items } = await engine.list({ type: 'scheduled-document' });
    const completed = await engine.get(items[0]!.id);
    expect(completed?.result).toEqual({
      greeting: 'tick',
      trigger: fire,
      previous: null,
    });
  });
});

describe('restarting after a crash', () => {
  it('resumes an instance parked on await-signal from that step, without rerunning the steps before it', async () => {
    traces.length = 0;
    const storage = new MemoryStorage();
    const document = createDocument('crash-signal', [
      { kind: 'activity', handler: 'trace', input: 'before' },
      { kind: 'await-signal', signal: 'go' },
      { kind: 'activity', handler: 'trace', input: 'after' },
    ]);
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, host, { active: [document] });
      await original.start('crash-signal', null, { id: 'crash-signal-run' });
      await waitForParkedOnSignal(original, 'crash-signal-run');
    }
    expect(traces.map((entry) => entry.input)).toEqual(['before']);

    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, host, { active: [document] });
    const [handle] = await restarted.recoverAll();
    await handle!.signal('go', 'resumed');

    expect(await handle!.result()).toBe('after');
    expect(traces.map((entry) => entry.input)).toEqual(['before', 'after']);
  });

  it('finishes a run pinned to a retained revision after a restart, while new runs use the active one', async () => {
    const storage = new MemoryStorage();
    const version1 = createDocument('pinned', [
      { kind: 'await-signal', signal: 'go' },
      { kind: 'activity', handler: 'version', input: 'one' },
    ]);
    const version2 = createDocument('pinned', [
      { kind: 'await-signal', signal: 'go' },
      { kind: 'activity', handler: 'version', input: 'two' },
    ]);
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, host, { active: [version1] });
      await original.start('pinned', null, { id: 'pinned-old-run' });
      await waitForParkedOnSignal(original, 'pinned-old-run');
    }

    await using restarted = new Engine({ storage });
    const [active] = await registerWorkflowDocuments(restarted, host, {
      active: [version2],
      retained: [version1],
    });
    const [recovered] = await restarted.recoverAll();
    const fresh = await restarted.start('pinned', null, { id: 'pinned-new-run' });
    await recovered!.signal('go', null);
    await fresh.signal('go', null);

    expect(recovered!.id).toBe('pinned-old-run');
    expect(await recovered!.result()).toBe('one');
    expect(await fresh.result()).toBe('two');
    const pointer = await restarted.workflows.getActive('pinned');
    expect(pointer?.revision).toBe(active!.revision);
  });

  it('resumes an instance parked on sleep from that step', async () => {
    const storage = new MemoryStorage();
    const document = createDocument('crash-sleep', [
      { kind: 'activity', handler: 'shout', input: 'before' },
      { kind: 'sleep', duration: '1m' },
      { kind: 'activity', handler: 'shout', input: 'after' },
    ]);
    const startedAt = Date.UTC(2026, 0, 1);
    {
      await using original = new Engine({ storage, getNow: () => startedAt });
      await registerWorkflowDocuments(original, host, { active: [document] });
      await original.start('crash-sleep', null, { id: 'crash-sleep-run' });
      await waitForCondition(
        async () => {
          const timeline = await original.getTimeline('crash-sleep-run');
          return timeline.some((entry) => entry.operationType === 'sleep');
        },
        { label: 'instance parked on its sleep' },
      );
    }

    await using restarted = new Engine({ storage, getNow: () => startedAt + 61_000 });
    await registerWorkflowDocuments(restarted, host, { active: [document] });
    const [handle] = await restarted.recoverAll();

    expect(await handle!.result()).toBe('"after":null');
  });
});

describe('the identity every activity handler receives', () => {
  it('names the instance and the zero-based index of the step among all steps', async () => {
    identities.length = 0;
    hangIdentify = false;
    const document = createDocument('identity-steps', [
      { kind: 'sleep', duration: 1 },
      { kind: 'activity', handler: 'identify' },
      { kind: 'activity', handler: 'identify' },
    ]);
    await using engine = await Engine.create({ storage: new MemoryStorage() });
    await registerWorkflowDocuments(engine, host, { active: [document] });

    const run = await engine.start('identity-steps', null, { id: 'identity-run' });

    expect(await run.result()).toEqual({ workflowId: 'identity-run', step: 2 });
    expect(identities).toEqual([
      { workflowId: 'identity-run', step: 1 },
      { workflowId: 'identity-run', step: 2 },
    ]);
  });

  it('gives a step that a restart re-executes the same workflow id and step', async () => {
    identities.length = 0;
    const storage = new MemoryStorage();
    const document = createDocument('identity-restart', [
      { kind: 'activity', handler: 'trace', input: 'first' },
      { kind: 'activity', handler: 'identify' },
    ]);
    hangIdentify = true;
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, host, { active: [document] });
      await original.start('identity-restart', null, { id: 'identity-restart-run' });
      await waitForCondition(async () => identities.length === 1, {
        label: 'the identify step to start',
      });
    }
    hangIdentify = false;

    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, host, { active: [document] });
    const [handle] = await restarted.recoverAll();

    expect(await handle!.result()).toEqual({ workflowId: 'identity-restart-run', step: 1 });
    expect(identities).toEqual([
      { workflowId: 'identity-restart-run', step: 1 },
      { workflowId: 'identity-restart-run', step: 1 },
    ]);
  });
});
