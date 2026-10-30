/**
 * COR-1812 — workflow input and output schemas over a real Bureau: a manual start, a signal
 * trigger, and a start the engine makes by itself (what a schedule fire is) are judged against the
 * file's `inputSchema`, a result that breaks the `outputSchema` fails the run with `output-invalid`,
 * and the schemas survive being paused, rewritten, and read back as a revision.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import { BureauError } from './create-bureau';
import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';
import { AGENT_STEP } from './testing/workflow-file-fixtures.test-support';
import type { BureauWorkflows } from './workflow-runtime';
import { WorkflowInputInvalidError } from './workflow-schema';
import { createSqliteStorageFixture } from './test/storage-fixtures';

const harnesses: WorkflowBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
});

async function start(options?: Parameters<typeof startWorkflowBureau>[0]) {
  const harness = await startWorkflowBureau(options);
  harnesses.push(harness);
  return harness;
}

const CITY_INPUT = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
} as const;
const ON_GO = { kind: 'signal', name: 'go' };

function workflowsOf(harness: WorkflowBureauHarness): BureauWorkflows {
  return harness.bureau.workflows!;
}

/** Wait until the engine has `id` in a terminal state, and return it. */
async function finished(harness: WorkflowBureauHarness, id: string) {
  const engine = harness.bureau.durableEngine()!;
  let state = await engine.get(id);
  await waitUntil(
    async () => {
      state = await engine.get(id);
      return (
        state !== null &&
        state !== undefined &&
        state.status !== 'running' &&
        state.status !== 'pending'
      );
    },
    { message: `${id} finished` },
  );
  return state!;
}

/** The status the engine settles `id` in. */
async function statusAfter(harness: WorkflowBureauHarness, id: string): Promise<string> {
  const state = await finished(harness, id);
  return state.status;
}

/** The finish reason `runs.get` reports for `id`. */
async function finishReasonAfter(harness: WorkflowBureauHarness, id: string) {
  const run = await workflowsOf(harness).getRun(id);
  return run?.finishReason;
}

async function instances(harness: WorkflowBureauHarness, workflow: string) {
  const page = await harness.bureau.durableEngine()!.list({ type: workflow });
  return page.items;
}

async function refusal(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('bureau.workflows.start', () => {
  it('starts an instance whose input satisfies the schema, as a person, owned by the caller', async () => {
    const harness = await start({ replies: { writer: () => 'done' } });
    await harness.putWorkflow('lookup', { trigger: ON_GO, inputSchema: CITY_INPUT });

    const result = await workflowsOf(harness).start('lookup', {
      input: { city: 'Oslo' },
      owner: 'api-key:alice',
      surface: 'palette',
    });

    expect(result.workflow).toBe('lookup');
    expect(result.workflowVersion).toBe(workflowsOf(harness).list()[0]?.version ?? '');
    const state = await finished(harness, result.runId);
    expect(state.status).toBe('completed');
    expect(state.tags).toEqual(['origin:person']);
    expect(state.input).toEqual({
      kind: 'manual',
      input: { city: 'Oslo' },
      origin: { kind: 'person', principal: 'api-key:alice', surface: 'palette' },
    });
    const run = await workflowsOf(harness).getRun(result.runId);
    expect(run?.finishReason).toBeNull();
    expect(harness.calls[0]?.message).toContain('"city": "Oslo"');
  });

  it('records the api surface when the caller names none', async () => {
    const harness = await start();
    await harness.putWorkflow('lookup', { trigger: ON_GO });

    const result = await workflowsOf(harness).start('lookup', { owner: 'anonymous:local' });

    const state = await finished(harness, result.runId);
    expect(state.input).toEqual({
      kind: 'manual',
      input: null,
      origin: { kind: 'person', principal: 'anonymous:local', surface: 'api' },
    });
  });

  it('refuses an input that breaks the schema with every issue, and creates no instance', async () => {
    const harness = await start();
    await harness.putWorkflow('lookup', { trigger: ON_GO, inputSchema: CITY_INPUT });

    const error = await refusal(
      workflowsOf(harness).start('lookup', {
        input: { days: 3 },
        owner: 'anonymous:local',
      }),
    );

    expect(error).toBeInstanceOf(WorkflowInputInvalidError);
    const issues = (error as WorkflowInputInvalidError).issues;
    expect(issues.map((issue) => issue.path)).toEqual([['city'], ['days']]);
    expect(issues.map((issue) => issue.message)).toEqual([
      '"city" is required',
      '"days" is not an allowed field',
    ]);
    expect(await instances(harness, 'lookup')).toEqual([]);
    expect(harness.calls).toEqual([]);
  });

  it('refuses a start with no input when the schema asks for one', async () => {
    const harness = await start();
    await harness.putWorkflow('lookup', { trigger: ON_GO, inputSchema: CITY_INPUT });

    const error = await refusal(workflowsOf(harness).start('lookup', { owner: 'anonymous:local' }));

    expect(error).toBeInstanceOf(WorkflowInputInvalidError);
    expect(await instances(harness, 'lookup')).toEqual([]);
  });

  it('starts a workflow with no schema with any JSON input', async () => {
    const harness = await start();
    await harness.putWorkflow('free', { trigger: ON_GO });

    const result = await workflowsOf(harness).start('free', {
      input: [1, 'two', { three: 3 }],
      owner: 'anonymous:local',
    });

    expect(await statusAfter(harness, result.runId)).toBe('completed');
  });

  it('answers a missing, invalid, or paused workflow as not found, and a non-JSON input as bad request', async () => {
    const harness = await start();
    await harness.putWorkflow('paused-one', { trigger: ON_GO, paused: true });
    await harness.put('broken.json', '{ not json');
    await workflowsOf(harness).refresh();
    await harness.putWorkflow('live', { trigger: ON_GO });

    for (const id of ['nobody', 'broken', 'paused-one']) {
      const error = await refusal(workflowsOf(harness).start(id, { owner: 'anonymous:local' }));
      expect(error, id).toBeInstanceOf(BureauError);
      expect((error as BureauError).code, id).toBe('NOT_FOUND');
    }
    const bad = await refusal(
      workflowsOf(harness).start('live', { input: { n: Number.NaN }, owner: 'anonymous:local' }),
    );
    expect((bad as BureauError).code).toBe('BAD_REQUEST');
    expect(await instances(harness, 'live')).toEqual([]);
  });
});

describe('a signal trigger and an inputSchema', () => {
  it('starts nothing for a workflow whose schema the payload breaks, reports it, and starts the others', async () => {
    const harness = await start();
    await harness.putWorkflow('strict', { trigger: ON_GO, inputSchema: CITY_INPUT });
    await harness.putWorkflow('lenient', { trigger: ON_GO });

    const result = await workflowsOf(harness).signal('go', { days: 3 });

    expect(result.started).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.id).toBe('strict');
    expect(result.rejected[0]?.issues.map((issue) => issue.message)).toEqual([
      '"city" is required',
      '"days" is not an allowed field',
    ]);
    expect(await instances(harness, 'strict')).toEqual([]);
    expect(await instances(harness, 'lenient')).toHaveLength(1);
  });

  it('starts the workflow when the payload satisfies the schema', async () => {
    const harness = await start();
    await harness.putWorkflow('strict', { trigger: ON_GO, inputSchema: CITY_INPUT });

    const result = await workflowsOf(harness).signal('go', { city: 'Oslo' });

    expect(result.rejected).toEqual([]);
    expect(result.started).toHaveLength(1);
    expect(await statusAfter(harness, result.started[0]!)).toBe('completed');
  });
});

describe('a start the engine makes itself, which is what a schedule fire is', () => {
  it('creates the instance and fails it with input-invalid and the issues, before any step runs', async () => {
    const harness = await start();
    // A file with a schedule trigger cannot declare a schema that refuses null (COR-1927), so this
    // is a file with another trigger that the engine is handed a schedule fire's trigger for.
    await harness.putWorkflow('nightly', { trigger: ON_GO, inputSchema: CITY_INPUT });

    // The trigger a fire starts the instance with.
    const handle = await harness.bureau
      .durableEngine()!
      .start(
        'nightly',
        { kind: 'schedule', scheduleId: 'bureau-workflow-schedule:nightly:1' },
        { id: 'fire-1' },
      );

    const state = await finished(harness, handle.id);
    expect(state.status).toBe('failed');
    // A fire carries no input, so a schema that asks for an object cannot be satisfied by it.
    expect(state.error).toBe('input-invalid: The input must be object');
    expect(harness.calls).toEqual([]);
    const run = await workflowsOf(harness).getRun('fire-1');
    expect(run?.finishReason).toBe('input-invalid');
    expect(run?.error).toBe('input-invalid: The input must be object');
  });

  it('judges a raw start’s input as it is, so a start nobody validated still cannot run on bad input', async () => {
    const harness = await start();
    await harness.putWorkflow('lookup', { trigger: ON_GO, inputSchema: CITY_INPUT });
    const engine = harness.bureau.durableEngine()!;

    const bad = await engine.start('lookup', { days: 3 }, { id: 'raw-bad' });
    const good = await engine.start('lookup', { city: 'Oslo' }, { id: 'raw-good' });

    expect(await statusAfter(harness, bad.id)).toBe('failed');
    expect(await statusAfter(harness, good.id)).toBe('completed');
  });
});

describe('an outputSchema', () => {
  it('fails the instance with output-invalid and the issues when the result breaks it', async () => {
    const harness = await start({ replies: { writer: () => 'a sentence' } });
    // An agent step's result is an object, so a string schema can never be satisfied.
    await harness.putWorkflow('summary', { trigger: ON_GO, outputSchema: { type: 'string' } });

    const result = await workflowsOf(harness).start('summary', { owner: 'anonymous:local' });

    const state = await finished(harness, result.runId);
    expect(state.status).toBe('failed');
    expect(state.error).toBe('output-invalid: The output must be string');
    const run = await workflowsOf(harness).getRun(result.runId);
    expect(run?.status).toBe('failed');
    expect(run?.finishReason).toBe('output-invalid');
    expect(run?.error).toBe('output-invalid: The output must be string');
    expect(run?.result).toBeUndefined();
  });

  it('completes the instance when the result satisfies it', async () => {
    const harness = await start({ replies: { writer: () => 'a sentence' } });
    await harness.putWorkflow('summary', {
      trigger: ON_GO,
      outputSchema: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
      },
    });

    const result = await workflowsOf(harness).start('summary', { owner: 'anonymous:local' });

    const run = await finished(harness, result.runId);
    expect(run.status).toBe('completed');
    expect(await finishReasonAfter(harness, result.runId)).toBeNull();
  });

  it('does not call a failed agent step an output failure', async () => {
    const harness = await start({
      replies: {
        writer: () => {
          throw new Error('provider down');
        },
      },
    });
    await harness.putWorkflow('summary', { trigger: ON_GO, outputSchema: { type: 'string' } });

    const result = await workflowsOf(harness).start('summary', { owner: 'anonymous:local' });

    await finished(harness, result.runId);
    expect(await finishReasonAfter(harness, result.runId)).toBeNull();
  });
});

describe('the finish reason of a failed run after a restart (COR-1927)', () => {
  it('is still read from the stored run, which keeps the class of the error that failed it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bureau-workflow-finish-reason-'));
    const database = createSqliteStorageFixture({ path: join(root, 'bureau.sqlite') });
    try {
      const overrides = {
        // A getter: each Bureau started with these overrides opens its own handle.
        get storage() {
          return database.open();
        },
        durableOwnership: { ownership: 'none' },
        onDiagnostic: () => undefined,
      } as const;
      const directory = join(root, 'workflows');
      const first = await startWorkflowBureau({ directory, overrides });
      await first.putWorkflow('summary', { trigger: ON_GO, outputSchema: { type: 'string' } });
      const result = await workflowsOf(first).start('summary', { owner: 'anonymous:local' });
      await finished(first, result.runId);
      const before = await workflowsOf(first).getRun(result.runId);
      expect(before?.finishReason).toBe('output-invalid');
      await first.dispose();

      const second = await startWorkflowBureau({ directory, overrides });
      harnesses.push(second);
      const run = await workflowsOf(second).getRun(result.runId);
      expect(run?.status).toBe('failed');
      expect(run?.finishReason).toBe('output-invalid');
    } finally {
      for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
      await database.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('the schemas in the file', () => {
  it('survive pausing and resuming, which rewrite the file', async () => {
    const harness = await start();
    await workflowsOf(harness).create('lookup', {
      agent: 'writer',
      trigger: ON_GO,
      steps: [AGENT_STEP],
      inputSchema: { ...CITY_INPUT },
      outputSchema: { type: 'object' },
    });
    const versionBefore = workflowsOf(harness).list()[0]?.version;
    const hash = workflowsOf(harness).list()[0]!.hash!;

    const paused = await workflowsOf(harness).pause('lookup', { expectedHash: hash });
    await workflowsOf(harness).resume('lookup', { expectedHash: paused.hash });

    const text = await readFile(join(harness.directory, 'lookup.json'), 'utf8');
    expect(JSON.parse(text)).toMatchObject({
      inputSchema: CITY_INPUT,
      outputSchema: { type: 'object' },
    });
    const listing = workflowsOf(harness).list()[0]!;
    expect(listing.inputSchema).toEqual(CITY_INPUT);
    expect(listing.outputSchema).toEqual({ type: 'object' });
    expect(listing.version).toBe(versionBefore);
  });

  it('are part of a revision: a schema-only edit is a new revision, and the old one keeps its schema', async () => {
    const harness = await start();
    await harness.putWorkflow('lookup', { trigger: ON_GO, inputSchema: CITY_INPUT });
    const first = workflowsOf(harness).list()[0]!;
    const oldRun = await workflowsOf(harness).start('lookup', {
      input: { city: 'Oslo' },
      owner: 'anonymous:local',
    });
    await finished(harness, oldRun.runId);

    await harness.putWorkflow('lookup', { trigger: ON_GO });
    const second = workflowsOf(harness).list()[0]!;

    expect(second.version).not.toBe(first.version);
    expect(second.inputSchema).toBeNull();
    const revisions = await workflowsOf(harness).revisions('lookup');
    expect(revisions?.map((revision) => revision.workflowVersion)).toEqual([first.version!]);
    expect(revisions?.[0]?.document.inputSchema).toEqual(CITY_INPUT);
    // With the schema gone, the new revision takes any input.
    const free = await workflowsOf(harness).start('lookup', {
      input: { anything: true },
      owner: 'anonymous:local',
    });
    expect(await statusAfter(harness, free.runId)).toBe('completed');
  });

  it('are refused by an update that would break the limits, and the file is left as it was', async () => {
    const harness = await start();
    await harness.putWorkflow('lookup', { trigger: ON_GO });
    const before = await readFile(join(harness.directory, 'lookup.json'), 'utf8');
    const hash = workflowsOf(harness).list()[0]!.hash!;

    const error = await refusal(
      workflowsOf(harness).update(
        'lookup',
        {
          trigger: ON_GO,
          steps: [AGENT_STEP],
          inputSchema: { type: 'string', pattern: '^a' },
        },
        { expectedHash: hash },
      ),
    );

    expect((error as { code?: string }).code).toBe('invalid-document');
    expect(await readFile(join(harness.directory, 'lookup.json'), 'utf8')).toBe(before);
  });
});
