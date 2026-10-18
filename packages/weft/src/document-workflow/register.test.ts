import { describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine/index.ts';
import {
  WorkflowRevisionActivatedEvent,
  WorkflowRevisionDrainingEvent,
  WorkflowRevisionInstalledEvent,
} from '../core/events/catalog-events.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { waitForCondition } from '../testing/fake-timers.test-support.ts';
import { throwingRejectionOf } from '../testing/promise-outcome.test-support.ts';
import {
  WorkflowDocumentValidationError,
  workflowDocumentVersion,
  type DocumentWorkflowHost,
} from './document.ts';
import { registerWorkflowDocument, registerWorkflowDocuments } from './register.ts';

const handlerCalls: string[] = [];
const traces: { input: unknown; trigger: unknown; previous: unknown }[] = [];

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

async function waitForCheckpoint(storage: MemoryStorage, workflowId: string): Promise<void> {
  await waitForCondition(async () => (await storage.get(KEYS.checkpoint(workflowId))) !== null, {
    label: `checkpoint for ${workflowId}`,
  });
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
    expect(await throwingRejectionOf(engine.start('valid-document', null))).toThrow(
      'valid-document',
    );
  });

  it('rejects two active documents for one name', async () => {
    const first = createDocument('twice', [{ kind: 'activity', handler: 'greet' }]);
    const second = createDocument('twice', [{ kind: 'activity', handler: 'shout' }]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });

    expect(
      await throwingRejectionOf(
        registerWorkflowDocuments(engine, host, { active: [first, second] }),
      ),
    ).toThrow('"twice"');
  });
});

describe('registerWorkflowDocument()', () => {
  it('registers one document without loading or activating it', async () => {
    const document = createDocument('single', [{ kind: 'activity', handler: 'greet' }]);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });

    const registered = await registerWorkflowDocument(engine, host, document);

    expect(registered.workflowVersion).toBe(
      await workflowDocumentVersion({
        name: 'single',
        trigger: { kind: 'manual' },
        steps: [{ kind: 'activity', handler: 'greet' }],
      }),
    );
    expect(await engine.workflows.getActive('single')).toBeNull();
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
  it('resumes an instance parked on await-signal from that step', async () => {
    const storage = new MemoryStorage();
    const document = createDocument('crash-signal', [
      { kind: 'activity', handler: 'shout', input: 'before' },
      { kind: 'await-signal', signal: 'go' },
      { kind: 'activity', handler: 'shout', input: 'after' },
    ]);
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, host, { active: [document] });
      await original.start('crash-signal', null, { id: 'crash-signal-run' });
      await waitForCheckpoint(storage, 'crash-signal-run');
    }

    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, host, { active: [document] });
    const [handle] = await restarted.recoverAll();
    await handle!.signal('go', 'resumed');

    expect(await handle!.result()).toBe('"after":"resumed"');
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
