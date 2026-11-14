/**
 * COR-2009 — the saved versions of a workflow: numbered `1.0.0`, `1.1.0`, … in the order saved,
 * each with what changed and whether a run in flight could carry on (the workflow page's History
 * tab), and the same verdict before a save (the builder's compatibility notice).
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import { BureauError } from './bureau-errors';
import { ownerRpc, serveWorkflows } from './http/management/workflows-fixtures.test-support';
import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';
import { WorkflowFileError, type WorkflowFileDefinition } from './workflow-file';
import {
  compareWorkflowRevisions,
  compatibilityOf,
  createWorkflowRevisionLedger,
  type ObservedWorkflowFile,
  type WorkflowRevisionContent,
  workflowRevisionLabel,
} from './workflow-revision-ledger';

/** Release notes as the workflow page draws it: four steps, the last a signal wait. */
const RELEASE_NOTES: WorkflowFileDefinition = {
  title: 'Release notes',
  description: 'Collects merged changes into a draft.',
  trigger: {
    kind: 'schedule',
    spec: '0 11 * * 5',
    timezone: 'America/Chicago',
    overlap: 'skip',
    catchUp: false,
  },
  steps: [
    agentStep('Find the last release', 'Find the most recent release and when it was made.'),
    agentStep('Collect merged changes', 'Collect the changes merged since the last release.'),
    agentStep('Draft the notes', 'Draft release notes from the collected changes.'),
    { title: 'Wait for approval', kind: 'await-signal', signal: 'notes-approved' },
  ],
};

function agentStep(title: string, message: string) {
  return { title, kind: 'activity', handler: 'agent', input: { agent: 'writer', message } };
}

function contentOf(definition: WorkflowFileDefinition): WorkflowRevisionContent {
  return {
    title: definition.title ?? null,
    description: definition.description ?? null,
    trigger: definition.trigger,
    steps: definition.steps,
    inputSchema: definition.inputSchema ?? null,
    outputSchema: definition.outputSchema ?? null,
  };
}

/** `RELEASE_NOTES` with step `index` replaced. */
function withStep(index: number, step: Record<string, unknown>): WorkflowFileDefinition {
  const steps = [...RELEASE_NOTES.steps];
  steps[index] = step;
  return { ...RELEASE_NOTES, steps };
}

function changesTo(after: WorkflowFileDefinition) {
  return compareWorkflowRevisions(contentOf(RELEASE_NOTES), contentOf(after));
}

describe('comparing two versions', () => {
  it('numbers the versions 1.0.0, 1.1.0, 1.2.0 in the order saved', () => {
    expect([0, 1, 2, 13].map(workflowRevisionLabel)).toEqual(['1.0.0', '1.1.0', '1.2.0', '1.13.0']);
  });

  it('finds no change between a version and itself', () => {
    expect(changesTo(RELEASE_NOTES)).toEqual([]);
  });

  it('calls renaming a step compatible: it is a label', () => {
    const changes = changesTo(
      withStep(3, { ...RELEASE_NOTES.steps[3], title: 'Approve the notes' }),
    );
    expect(changes).toEqual([
      {
        kind: 'step-renamed',
        step: 4,
        from: 'Wait for approval',
        to: 'Approve the notes',
        breaking: false,
      },
    ]);
    expect(compatibilityOf(changes)).toBe('compatible');
  });

  it('calls rewording a step compatible (1.3.0, "reworded step 2")', () => {
    const changes = changesTo(
      withStep(
        1,
        agentStep('Collect merged changes', 'Collect the pull requests merged since then.'),
      ),
    );
    expect(changes).toEqual([{ kind: 'step-reworded', step: 2, breaking: false }]);
    expect(compatibilityOf(changes)).toBe('compatible');
  });

  it('calls adding a step at the end compatible (1.2.0, "added the approval step")', () => {
    const before = { ...RELEASE_NOTES, steps: RELEASE_NOTES.steps.slice(0, 3) };
    const changes = compareWorkflowRevisions(contentOf(before), contentOf(RELEASE_NOTES));
    expect(changes).toEqual([{ kind: 'step-added', step: 4, breaking: false }]);
    expect(compatibilityOf(changes)).toBe('compatible');
  });

  it('calls a new signal on a waiting step breaking (1.4.0, release-approved instead of notes-approved)', () => {
    const changes = changesTo(
      withStep(3, { title: 'Wait for approval', kind: 'await-signal', signal: 'release-approved' }),
    );
    expect(changes).toEqual([
      {
        kind: 'step-signal',
        step: 4,
        from: 'notes-approved',
        to: 'release-approved',
        breaking: true,
      },
    ]);
    expect(compatibilityOf(changes)).toBe('breaking');
  });

  it('calls removing a step, replacing one, or changing the workflow input breaking', () => {
    expect(changesTo({ ...RELEASE_NOTES, steps: RELEASE_NOTES.steps.slice(0, 3) })).toEqual([
      { kind: 'step-removed', step: 4, breaking: true },
    ]);
    expect(changesTo(withStep(1, { kind: 'sleep', duration: '1h' }))).toEqual([
      { kind: 'step-replaced', step: 2, breaking: true },
    ]);
    const input = changesTo({ ...RELEASE_NOTES, inputSchema: { type: 'object' } });
    expect(input).toEqual([{ kind: 'input-schema', breaking: true }]);
  });

  it('calls pointing a workflow step at another workflow breaking, and another input likewise (COR-2246)', () => {
    const call = (workflow: string, input?: unknown) => ({
      ...RELEASE_NOTES,
      steps: [
        ...RELEASE_NOTES.steps.slice(0, 1),
        { kind: 'workflow', workflow, ...(input === undefined ? {} : { input }) },
      ],
    });
    const before = contentOf(call('kit:sync'));
    expect(compareWorkflowRevisions(before, contentOf(call('kit:other')))).toEqual([
      { kind: 'step-replaced', step: 2, breaking: true },
    ]);
    expect(compareWorkflowRevisions(before, contentOf(call('kit:sync', { a: 1 })))).toEqual([
      { kind: 'step-input', step: 2, breaking: true },
    ]);
    expect(compareWorkflowRevisions(before, contentOf(call('kit:sync')))).toEqual([]);
  });

  it('calls a person deciding a wait, a new trigger, a new agent and a new title compatible', () => {
    const changes = changesTo({
      ...withStep(3, { ...RELEASE_NOTES.steps[3], review: true }),
      title: 'Weekly release notes',
      trigger: { ...RELEASE_NOTES.trigger, spec: '0 10 * * 5' },
      steps: [
        {
          ...agentStep(
            'Find the last release',
            'Find the most recent release and when it was made.',
          ),
          input: { agent: 'editor', message: 'Find the most recent release and when it was made.' },
        },
        ...withStep(3, { ...RELEASE_NOTES.steps[3], review: true }).steps.slice(1),
      ],
    });
    expect(changes.map((change) => change.kind)).toEqual([
      'title',
      'trigger',
      'step-agent',
      'step-review',
    ]);
    expect(compatibilityOf(changes)).toBe('compatible');
  });
});

describe('the ledger', () => {
  function observed(definition: WorkflowFileDefinition, hash: string): ObservedWorkflowFile {
    return {
      id: 'release-notes',
      hash,
      version: 'sha256:document',
      agent: null,
      paused: false,
      stepAnnotations: [],
      document: { name: 'release-notes', trigger: { kind: 'manual' }, steps: [] },
      ...contentOf(definition),
    };
  }

  it('records a version once, however many Bureaus sharing the store observe it', async () => {
    const store = textValueStore(new MemoryStorage());
    const nowISO = () => '2026-11-01T21:30:00.000Z';
    const first = createWorkflowRevisionLedger({ store, nowISO });
    const second = createWorkflowRevisionLedger({ store, nowISO });
    await Promise.all([
      first.observe(observed(RELEASE_NOTES, 'a'), { origin: 'file' }),
      second.observe(observed(RELEASE_NOTES, 'a'), { origin: 'file' }),
    ]);
    const records = await first.list('release-notes');
    expect(records.map((record) => record.version)).toEqual(['1.0.0']);
  });

  it('keeps another workflow’s versions apart, even one whose identifier extends this one', async () => {
    const store = textValueStore(new MemoryStorage());
    const ledger = createWorkflowRevisionLedger({ store, nowISO: () => new Date(0).toISOString() });
    await ledger.observe(observed(RELEASE_NOTES, 'a'), { origin: 'file' });
    await ledger.observe(
      { ...observed(RELEASE_NOTES, 'b'), id: 'linear:release-notes' },
      {
        origin: 'file',
      },
    );
    expect(await ledger.list('release-notes')).toHaveLength(1);
    expect(await ledger.list('linear:release-notes')).toHaveLength(1);
  });
});

describe('a workflow’s history on a Bureau', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  });

  async function start(): Promise<WorkflowBureauHarness> {
    const harness = await startWorkflowBureau();
    cleanups.push(() => harness.dispose());
    return harness;
  }

  const MANUAL = { ...RELEASE_NOTES, trigger: { kind: 'manual' } };

  it('records the file it finds as 1.0.0, and a save through Bureau as the next version, with who saved it and from where', async () => {
    const harness = await start();
    const workflows = harness.bureau.workflows!;
    const created = await workflows.create('release-notes', MANUAL);
    const reworded = withStep(
      1,
      agentStep('Collect merged changes', 'Collect the pull requests merged since then.'),
    );
    await workflows.update(
      'release-notes',
      { ...reworded, trigger: MANUAL.trigger },
      { expectedHash: created.hash, actor: 'person:steve', surface: 'web' },
    );

    const history = await workflows.history('release-notes');
    expect(history?.map((entry) => [entry.version, entry.current])).toEqual([
      ['1.1.0', true],
      ['1.0.0', false],
    ]);
    expect(history?.[0]).toMatchObject({
      origin: 'write',
      actor: 'person:steve',
      surface: 'web',
      previousVersion: '1.0.0',
      changes: [{ kind: 'step-reworded', step: 2, breaking: false }],
      compatibility: 'compatible',
      content: { title: 'Release notes', steps: reworded.steps },
    });
    expect(history?.[1]).toMatchObject({ compatibility: null, changes: [] });
  });

  it('adds no version for pausing, and one for a title alone, which leaves the Weft version as it was', async () => {
    const harness = await start();
    const workflows = harness.bureau.workflows!;
    const created = await workflows.create('release-notes', MANUAL);
    const paused = await workflows.pause('release-notes', { expectedHash: created.hash });
    await workflows.update(
      'release-notes',
      { ...MANUAL, title: 'Weekly release notes', paused: true },
      { expectedHash: paused.hash },
    );
    const history = (await workflows.history('release-notes')) ?? [];
    expect(history.map((entry) => entry.version)).toEqual(['1.1.0', '1.0.0']);
    expect(history[0]?.changes).toEqual([
      { kind: 'title', from: 'Release notes', to: 'Weekly release notes', breaking: false },
    ]);
    expect(history[0]?.workflowVersion).toBe(history[1]!.workflowVersion);
  });

  it('records a file changed by hand as a version that Bureau found', async () => {
    const harness = await start();
    await harness.putWorkflow('release-notes', { ...MANUAL, name: 'release-notes' });
    await harness.putWorkflow('release-notes', {
      ...withStep(3, {
        title: 'Wait for approval',
        kind: 'await-signal',
        signal: 'release-approved',
      }),
      trigger: MANUAL.trigger,
      name: 'release-notes',
    });
    const [latest] = (await harness.bureau.workflows!.history('release-notes')) ?? [];
    expect(latest).toMatchObject({
      version: '1.1.0',
      origin: 'file',
      actor: null,
      compatibility: 'breaking',
    });
  });

  it('counts the runs that started on each version', async () => {
    const harness = await start();
    const workflows = harness.bureau.workflows!;
    const created = await workflows.create('release-notes', MANUAL);
    await workflows.start('release-notes', { owner: 'person:steve' });
    await workflows.update(
      'release-notes',
      { ...MANUAL, title: 'Weekly release notes' },
      { expectedHash: created.hash },
    );
    const history = (await workflows.history('release-notes')) ?? [];
    expect(history.map((entry) => entry.runs.count)).toEqual([0, 1]);
    expect(history[1]?.runs.firstRunAt).not.toBeNull();
  });

  it('answers undefined for a workflow with neither a file nor a version', async () => {
    const harness = await start();
    expect(await harness.bureau.workflows!.history('nothing')).toBeUndefined();
  });

  it('says before a save what the save will record, and the save records exactly that', async () => {
    const harness = await start();
    const workflows = harness.bureau.workflows!;
    const created = await workflows.create('release-notes', MANUAL);
    const proposed = {
      ...withStep(3, {
        title: 'Wait for approval',
        kind: 'await-signal',
        signal: 'release-approved',
      }),
      trigger: MANUAL.trigger,
    };

    const impact = await workflows.impact('release-notes', proposed);
    expect(impact).toEqual({
      version: '1.1.0',
      previousVersion: '1.0.0',
      changes: [
        {
          kind: 'step-signal',
          step: 4,
          from: 'notes-approved',
          to: 'release-approved',
          breaking: true,
        },
      ],
      compatibility: 'breaking',
      inFlight: 0,
    });
    await workflows.update('release-notes', proposed, { expectedHash: created.hash });
    const [saved] = (await workflows.history('release-notes')) ?? [];
    expect(saved).toMatchObject({
      version: impact.version,
      previousVersion: impact.previousVersion,
      changes: impact.changes,
      compatibility: impact.compatibility,
    });
  });

  it('says a save that changes nothing makes no version, and a new workflow starts at 1.0.0', async () => {
    const harness = await start();
    const workflows = harness.bureau.workflows!;
    await workflows.create('release-notes', MANUAL);
    expect(await workflows.impact('release-notes', { ...MANUAL, paused: true })).toMatchObject({
      version: null,
      previousVersion: '1.0.0',
      compatibility: null,
    });
    expect(await workflows.impact('morning-briefing', MANUAL)).toMatchObject({
      version: '1.0.0',
      previousVersion: null,
    });
  });

  it('counts the runs in flight, and refuses a definition that would not load', async () => {
    const harness = await start();
    const workflows = harness.bureau.workflows!;
    await workflows.create('approval', {
      trigger: { kind: 'manual' },
      steps: [{ kind: 'await-signal', signal: 'go' }],
    });
    await workflows.start('approval', { owner: 'person:steve' });
    const impact = await workflows.impact('approval', {
      trigger: { kind: 'manual' },
      steps: [{ kind: 'await-signal', signal: 'go-ahead' }],
    });
    expect(impact.inFlight).toBe(1);
    const refused = await workflows
      .impact('approval', { trigger: { kind: 'manual' }, steps: [{ kind: 'nope' }] })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(WorkflowFileError);
    expect((refused as WorkflowFileError).code).toBe('invalid-document');
    expect(refused).not.toBeInstanceOf(BureauError);
  });
});

describe('the history and impact operations', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  });

  it('serve the history and the impact on the wire, and record the surface a save names', async () => {
    const served = await serveWorkflows(cleanups);
    const created = await ownerRpc(served.owner, 'bureau.workflows.create', {
      id: 'release-notes',
      definition: { ...RELEASE_NOTES, trigger: { kind: 'manual' } },
      surface: 'web',
    });
    expect(created.error).toBeUndefined();
    const impact = await ownerRpc(served.owner, 'bureau.workflows.impact', {
      id: 'release-notes',
      definition: {
        ...withStep(3, { title: 'Approve', kind: 'await-signal', signal: 'notes-approved' }),
        trigger: { kind: 'manual' },
      },
    });
    expect(impact.result).toEqual({
      version: '1.1.0',
      previousVersion: '1.0.0',
      changes: [
        {
          kind: 'step-renamed',
          step: 4,
          from: 'Wait for approval',
          to: 'Approve',
          breaking: false,
        },
      ],
      compatibility: 'compatible',
      inFlight: 0,
    });
    const history = await ownerRpc(served.owner, 'bureau.workflows.history', {
      id: 'release-notes',
    });
    expect(history.result?.['revisions']).toMatchObject([
      {
        version: '1.0.0',
        current: true,
        origin: 'write',
        surface: 'web',
        title: 'Release notes',
        compatibility: null,
        runs: { count: 0, firstRunAt: null, lastRunAt: null },
      },
    ]);
    const missing = await ownerRpc(served.owner, 'bureau.workflows.history', { id: 'nothing' });
    expect(missing.error?.data?.httpStatus).toBe(404);
  });
});
