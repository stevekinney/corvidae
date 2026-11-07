/**
 * COR-2009 — the extended workflow file format: a workflow `title`, a step `title`, `review: true`
 * on an `await-signal` step, `timezone`, `catchUp`, `name` and `input` on a `schedule` trigger, and the `manual`
 * trigger kind. Bureau strips every key but `manual` before Weft sees the document, so none of them
 * changes a revision's `workflowVersion`.
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';
import { AGENT_STEP } from './testing/workflow-file-fixtures.test-support';
import {
  parseWorkflowFile,
  serializeWorkflowFile,
  type WorkflowFileDefinition,
  workflowVersionOf,
} from './workflow-file';
import { createWorkflowDocumentHost } from './workflow-host';
import { workflowScheduleId } from './workflow-schedule';

const host = createWorkflowDocumentHost({
  runAgentStep: async () => ({ content: '', output: null, finishReason: 'stop-condition' }),
});

/**
 * The builder's sample JSON (PageWorkflowBuilder, "JSON tab"): every field the builder writes, in
 * the extended format.
 */
const MORNING_BRIEFING = {
  name: 'morning-briefing',
  title: 'Morning briefing',
  description: 'Summarizes yesterday and posts it after a person reviews it.',
  trigger: {
    kind: 'schedule',
    spec: '0 9 * * 1-5',
    timezone: 'America/Chicago',
    overlap: 'skip',
    catchUp: false,
  },
  steps: [
    {
      title: 'Summarize yesterday',
      kind: 'activity',
      handler: 'agent',
      input: { agent: 'assistant', message: 'Summarize what happened yesterday.' },
    },
    {
      title: 'Review the briefing',
      kind: 'await-signal',
      signal: 'approve-briefing',
      review: true,
    },
    {
      title: 'Post the briefing',
      kind: 'activity',
      handler: 'agent',
      input: { agent: 'assistant', message: 'Post the approved briefing.' },
    },
    { title: 'Wait', kind: 'sleep', duration: '15m' },
  ],
};

/** The same workflow with none of the extended format's keys. */
const MORNING_BRIEFING_PLAIN = {
  name: 'morning-briefing',
  trigger: { kind: 'schedule', spec: '0 9 * * 1-5', overlap: 'skip' },
  steps: [
    {
      kind: 'activity',
      handler: 'agent',
      input: { agent: 'assistant', message: 'Summarize what happened yesterday.' },
    },
    { kind: 'await-signal', signal: 'approve-briefing' },
    {
      kind: 'activity',
      handler: 'agent',
      input: { agent: 'assistant', message: 'Post the approved briefing.' },
    },
    { kind: 'sleep', duration: '15m' },
  ],
};

function parse(value: unknown, id = 'morning-briefing') {
  return parseWorkflowFile(id, JSON.stringify(value), host);
}

function contentsOf(value: unknown, id?: string) {
  const parsed = parse(value, id);
  if (!parsed.ok) throw new Error(parsed.problem.message);
  return parsed.file;
}

function issuesOf(value: unknown, id?: string) {
  const parsed = parse(value, id);
  if (parsed.ok) throw new Error('expected a problem');
  expect(parsed.problem.code).toBe('invalid-document');
  return parsed.problem.issues ?? [];
}

/** `MORNING_BRIEFING` with one step replaced. */
function withStep(index: number, step: Record<string, unknown>) {
  const steps = [...MORNING_BRIEFING.steps];
  steps[index] = step as (typeof steps)[number];
  return { ...MORNING_BRIEFING, steps };
}

describe('reading the extended format', () => {
  it('reads every key the builder writes and keeps them out of the document Weft is handed', () => {
    const file = contentsOf(MORNING_BRIEFING);

    expect(file.title).toBe('Morning briefing');
    expect(file.trigger).toEqual(MORNING_BRIEFING.trigger);
    expect(file.steps).toEqual(MORNING_BRIEFING.steps);
    expect(file.stepAnnotations).toEqual([
      { title: 'Summarize yesterday', review: false },
      { title: 'Review the briefing', review: true },
      { title: 'Post the briefing', review: false },
      { title: 'Wait', review: false },
    ]);
    expect(file.document.trigger).toEqual({
      kind: 'schedule',
      spec: '0 9 * * 1-5',
      overlap: 'skip',
    });
    expect(file.document.steps[1]).toEqual({ kind: 'await-signal', signal: 'approve-briefing' });
    for (const step of file.document.steps) {
      expect(Object.keys(step)).not.toContain('title');
      expect(Object.keys(step)).not.toContain('review');
    }
  });

  it('gives the same Weft version as the file without the extended keys, so a title is never a revision of its own', () => {
    expect(workflowVersionOf(contentsOf(MORNING_BRIEFING).document)).toBe(
      workflowVersionOf(contentsOf(MORNING_BRIEFING_PLAIN).document),
    );
  });

  it('orders nested annotations by canonical branch preorder', () => {
    const file = contentsOf({
      ...MORNING_BRIEFING_PLAIN,
      steps: [
        {
          kind: 'branch',
          on: 'status',
          cases: {
            ready: [{ kind: 'await-signal', signal: 'ready', title: 'Ready', review: true }],
          },
          otherwise: [{ kind: 'sleep', duration: '1s', title: 'Fallback' }],
        },
        { kind: 'await-signal', signal: 'done', title: 'Done', review: true },
      ],
    });
    expect(file.stepAnnotations).toEqual([
      { title: null, review: false },
      { title: 'Ready', review: true },
      { title: 'Fallback', review: false },
      { title: 'Done', review: true },
    ]);
    expect(JSON.stringify(file.document)).not.toContain('Ready');
  });

  it('reads a file without any extended key as before, with no title and no annotations set', () => {
    const file = contentsOf(MORNING_BRIEFING_PLAIN);
    expect(file.title).toBeNull();
    expect(file.stepAnnotations.every((step) => step.title === null && !step.review)).toBe(true);
    expect(file.trigger).toEqual(file.document.trigger);
  });

  it('takes a manual trigger, which Weft sees, and nothing beside its kind', () => {
    const manual = { ...MORNING_BRIEFING_PLAIN, trigger: { kind: 'manual' } };
    expect(contentsOf(manual).document.trigger).toEqual({ kind: 'manual' });
    expect(issuesOf({ ...manual, trigger: { kind: 'manual', spec: '1h' } })).toEqual([
      { path: 'trigger', message: 'a manual trigger takes no other key; unknown "spec"' },
    ]);
  });

  it('refuses a title that is blank, too long, or not a string, on the workflow and on a step', () => {
    for (const title of ['', '   ', 'x'.repeat(121), 7, null]) {
      expect(issuesOf({ ...MORNING_BRIEFING, title }).map((issue) => issue.path)).toEqual([
        'title',
      ]);
      expect(
        issuesOf(withStep(0, { ...MORNING_BRIEFING.steps[0], title })).map((issue) => issue.path),
      ).toEqual(['steps[0].title']);
    }
    expect(contentsOf({ ...MORNING_BRIEFING, title: 'x'.repeat(120) }).title).toHaveLength(120);
  });

  it('takes review only as true, and only on an await-signal step', () => {
    expect(
      issuesOf(withStep(1, { kind: 'await-signal', signal: 'approve-briefing', review: false })),
    ).toEqual([
      {
        path: 'steps[1].review',
        message: 'must be true, or left out for a step that waits for an outside signal',
      },
    ]);
    expect(issuesOf(withStep(0, { ...MORNING_BRIEFING.steps[0], review: true }))).toEqual([
      { path: 'steps[0].review', message: 'only an await-signal step can wait for a person' },
    ]);
  });

  it('refuses an unknown zone, a zone on an interval, and a catch-up that is not a boolean', () => {
    const trigger = MORNING_BRIEFING.trigger;
    expect(
      issuesOf({ ...MORNING_BRIEFING, trigger: { ...trigger, timezone: 'Mars/Olympus' } }),
    ).toEqual([
      {
        path: 'trigger',
        message: '"timezone" must be an IANA time zone, such as "America/Chicago" or "UTC"',
      },
    ]);
    expect(
      issuesOf({ ...MORNING_BRIEFING, trigger: { ...trigger, spec: '1h' } })[0]?.message,
    ).toContain('applies only to a cron "spec"');
    expect(
      issuesOf({ ...MORNING_BRIEFING, trigger: { ...trigger, catchUp: 'no' } })[0]?.message,
    ).toBe('"catchUp" must be true or false');
    expect(
      contentsOf({ ...MORNING_BRIEFING, trigger: { ...trigger, catchUp: true } }).trigger,
    ).toMatchObject({ catchUp: true });
  });

  it('reads a schedule name and input, keeps them out of the document, and leaves the version alone', () => {
    const named = {
      ...MORNING_BRIEFING,
      trigger: { ...MORNING_BRIEFING.trigger, name: 'Morning digest', input: { team: 'platform' } },
    };
    const file = contentsOf(named);
    expect(file.trigger).toEqual(named.trigger);
    expect(file.document.trigger).toEqual({
      kind: 'schedule',
      spec: '0 9 * * 1-5',
      overlap: 'skip',
    });
    expect(workflowVersionOf(file.document)).toBe(
      workflowVersionOf(contentsOf(MORNING_BRIEFING_PLAIN).document),
    );
  });

  it('refuses a schedule name that is blank, too long, or not a string', () => {
    const trigger = MORNING_BRIEFING.trigger;
    for (const name of ['', '   ', 'x'.repeat(121), 7]) {
      expect(issuesOf({ ...MORNING_BRIEFING, trigger: { ...trigger, name } })).toEqual([
        { path: 'trigger', message: '"name" must be a non-empty string of at most 120 characters' },
      ]);
    }
  });

  it('judges the schedule input against inputSchema when the file is written', () => {
    const inputSchema = {
      type: 'object',
      required: ['branch'],
      properties: { branch: { type: 'string' } },
    };
    const trigger = { ...MORNING_BRIEFING.trigger, input: { branch: 'main' } };
    expect(contentsOf({ ...MORNING_BRIEFING, inputSchema, trigger }).trigger).toMatchObject({
      input: { branch: 'main' },
    });
    // An input the schema refuses is the trigger's fault, located at its input.
    const refused = issuesOf({
      ...MORNING_BRIEFING,
      inputSchema,
      trigger: { ...trigger, input: {} },
    });
    expect(refused.map((issue) => issue.path)).toEqual(['trigger.input']);
    expect(refused[0]?.message).toContain(
      'every schedule fire starts the workflow with this input',
    );
    // No input, and an explicit `null`, are the same: every fire starts with `null`.
    for (const input of [undefined, null]) {
      const issues = issuesOf({
        ...MORNING_BRIEFING,
        inputSchema,
        trigger: { ...MORNING_BRIEFING.trigger, input },
      });
      expect(issues.map((issue) => issue.path)).toEqual(['inputSchema']);
      expect(issues[0]?.message).toContain('give the trigger an "input" the schema accepts');
    }
    // A file with no schema takes any input.
    expect(
      contentsOf({ ...MORNING_BRIEFING, trigger: { ...trigger, input: [1, 2] } }).trigger,
    ).toMatchObject({ input: [1, 2] });
  });

  it('refuses an input on a signal trigger, which starts with the payload it is sent', () => {
    const parsed = parse({
      ...MORNING_BRIEFING_PLAIN,
      trigger: { kind: 'signal', name: 'go', input: { branch: 'main' } },
    });
    if (parsed.ok) throw new Error('expected a problem');
    expect(parsed.problem.issues?.map((issue) => issue.path)).toEqual(['trigger']);
  });

  it('refuses a schedule key on a trigger of another kind', () => {
    const issues = issuesOf({
      ...MORNING_BRIEFING_PLAIN,
      trigger: { kind: 'signal', name: 'go', timezone: 'UTC' },
    });
    expect(issues.map((issue) => issue.path)).toEqual(['trigger']);
  });

  it('still refuses a step key nobody knows, and marks it as a newer Bureau’s', () => {
    const parsed = parse(withStep(3, { kind: 'sleep', duration: '15m', retries: 2 }));
    if (parsed.ok) throw new Error('expected a problem');
    expect(parsed.problem.unrecognizedKeys).toBe(true);
  });
});

describe('writing the extended format', () => {
  const definition: WorkflowFileDefinition = {
    title: MORNING_BRIEFING.title,
    description: MORNING_BRIEFING.description,
    trigger: MORNING_BRIEFING.trigger,
    steps: MORNING_BRIEFING.steps,
  };

  it('writes the keys in the order the Code tab shows them', () => {
    const text = serializeWorkflowFile('morning-briefing', {
      ...definition,
      agent: 'assistant',
      paused: false,
      inputSchema: { type: 'null' },
      outputSchema: { type: 'string' },
    });
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      'name',
      'title',
      'description',
      'agent',
      'paused',
      'trigger',
      'inputSchema',
      'outputSchema',
      'steps',
    ]);
  });

  it('reads back exactly what it wrote, every annotation included', () => {
    const file = contentsOf(JSON.parse(serializeWorkflowFile('morning-briefing', definition)));
    expect(file.title).toBe(definition.title ?? null);
    expect(file.trigger).toEqual(definition.trigger);
    expect(file.steps).toEqual(definition.steps);
  });
});

describe('the extended format on a Bureau', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  });

  async function start(): Promise<WorkflowBureauHarness> {
    const harness = await startWorkflowBureau({ agentNames: ['writer', 'assistant'] });
    cleanups.push(() => harness.dispose());
    return harness;
  }

  const SCHEDULED = {
    title: 'Release notes',
    trigger: {
      kind: 'schedule',
      spec: '0 11 * * 5',
      timezone: 'America/Chicago',
      overlap: 'skip',
      catchUp: false,
    },
    steps: [
      { title: 'Draft the notes', ...AGENT_STEP },
      { title: 'Wait for approval', kind: 'await-signal', signal: 'notes-approved' },
    ],
  };

  it('lists the title, the trigger and the steps as written', async () => {
    const harness = await start();
    await harness.putWorkflow('release-notes', SCHEDULED);
    const [listing] = harness.bureau.workflows?.list() ?? [];
    expect(listing).toMatchObject({
      id: 'release-notes',
      state: 'ready',
      title: 'Release notes',
      trigger: SCHEDULED.trigger,
      steps: SCHEDULED.steps,
    });
  });

  it('schedules the file in its time zone, without catching up', async () => {
    const harness = await start();
    await harness.putWorkflow('release-notes', SCHEDULED);
    const schedule = await harness.bureau.schedules.get('bureau-workflow-schedule:release-notes:1');
    expect(schedule).toMatchObject({
      cronExpression: '0 11 * * 5',
      timeZone: 'America/Chicago',
      backfill: false,
    });
  });

  it('keeps the title, the zone and the step titles when it pauses the file', async () => {
    const harness = await start();
    await harness.putWorkflow('release-notes', SCHEDULED);
    const workflows = harness.bureau.workflows!;
    const before = workflows.list()[0]!;
    await workflows.pause('release-notes', { expectedHash: before.hash! });
    const after = workflows.list()[0]!;
    expect(after).toMatchObject({
      paused: true,
      title: 'Release notes',
      trigger: SCHEDULED.trigger,
      steps: SCHEDULED.steps,
    });
    expect(after.version).toBe(before.version);
  });

  it("names the schedule by the trigger's name, and starts every fire with its input, which the schema accepts", async () => {
    const harness = await start();
    await harness.putWorkflow('release-notes', {
      ...SCHEDULED,
      trigger: { ...SCHEDULED.trigger, name: 'Release notes digest', input: { branch: 'main' } },
      inputSchema: {
        type: 'object',
        required: ['branch'],
        properties: { branch: { type: 'string' } },
      },
      steps: [{ title: 'Draft the notes', ...AGENT_STEP }],
    });
    const scheduleId = workflowScheduleId('release-notes', 1);
    expect(harness.bureau.workflows?.list()[0]?.state).toBe('ready');
    expect(await harness.bureau.schedules.get(scheduleId)).toMatchObject({
      description: 'Release notes digest',
    });
    const engine = harness.bureau.durableEngine()!;
    await engine.triggerSchedule(scheduleId);
    const statusOfRun = async () => {
      const page = await engine.list({ type: 'release-notes' });
      return page.items[0]?.status;
    };
    await waitUntil(async () => ['completed', 'failed'].includes((await statusOfRun()) ?? ''));
    // The input passed the interpreter's own check, and the agent step was shown it.
    expect(await statusOfRun()).toBe('completed');
    expect(harness.calls.at(-1)?.message).toContain('"branch": "main"');
  });

  it('starts a manual workflow when someone starts it, and gives it no schedule', async () => {
    const harness = await start();
    await harness.putWorkflow('triage-inbox', {
      title: 'Triage inbox',
      trigger: { kind: 'manual' },
      steps: [{ title: 'Read new messages', ...AGENT_STEP }],
    });
    const page = await harness.bureau.schedules.list({ status: ['active', 'paused'] });
    expect(page?.items).toEqual([]);
    const started = await harness.bureau.workflows!.start('triage-inbox', { owner: 'person:test' });
    expect(started.workflow).toBe('triage-inbox');
  });
});
