/**
 * COR-1524 — a file agent runs like a code-defined one, through `bureau.run` and through a session
 * run, with the same options. A run uses the definition it started with: editing or deleting the
 * file mid-run does not change it, and the snapshot is recorded under the file's hash.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { BureauError, UnknownScheduleAgentError } from './create-bureau';
import { runTask, taskContent, waitForTaskState } from './test';
import {
  agentFileText,
  KNOWN_MODEL,
  OTHER_MODEL,
} from './testing/agent-file-fixtures.test-support';
import {
  type FileBureauHarness,
  type Observation,
  startFileBureau,
} from './testing/agent-file-bureau.test-support';
import { pollUntil } from './schedule-fire-fixtures.test-support';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import { agentFileDirectory } from './sources/agent-file-directory';

const harnesses: FileBureauHarness[] = [];

async function start(options?: Parameters<typeof startFileBureau>[0]) {
  const harness = await startFileBureau(options);
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

const OPUS_5_5 = 'claude-opus-5-5';
const OPUS_5 = 'claude-opus-5';
const RESEARCHER = agentFileText(
  { name: 'Researcher', model: KNOWN_MODEL, tools: '[lookup-order]' },
  'You are a careful researcher.\n',
);

/** A script that waits on `gate` before it answers, so a test can change the world mid-run. */
function gated(answer: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return {
    release,
    started,
    script: async (): Promise<string> => {
      entered();
      await gate;
      return answer;
    },
  };
}

describe('tasks.start of a file agent', () => {
  it('runs the agent the file describes: its model, tools, and instructions', async () => {
    const { bureau, put, observed } = await start({ scripts: { [OPUS_5_5]: () => 'file reply' } });
    await put('researcher.md', RESEARCHER);
    await bureau.agents.refresh();
    const run = await bureau.tasks.start('researcher', 'hello');
    const result = await run.result();
    expect(result.finishReason).toBe('stop-condition');
    expect(await taskContent(run)).toBe('file reply');
    expect(observed).toEqual([
      {
        model: OPUS_5_5,
        tools: ['lookup-order', 'requestHumanInput', 'scheduleWakeup'],
        systemPrompt: 'You are a careful researcher.',
      },
    ]);
  });

  it('still runs a code-defined agent by its key, with its precise type', async () => {
    const { bureau } = await start();
    const run = await bureau.tasks.start('alpha', 'hello');
    expect(await taskContent(run)).toBe('alpha');
  });

  it('is refused with NOT_FOUND for a name no agent has, and for a file that is invalid', async () => {
    const { bureau, put } = await start();
    await put('broken.md', agentFileText({ model: 'anthropic/none' }));
    await bureau.agents.refresh();
    for (const name of ['ghost', 'broken']) {
      let thrown: unknown;
      try {
        await bureau.tasks.start(name, 'hello');
      } catch (error) {
        thrown = error;
      }
      expect(thrown, name).toBeInstanceOf(BureauError);
      expect((thrown as BureauError).code).toBe('NOT_FOUND');
    }
  });

  it('schedules a file agent, refuses a name no agent has, and still fails at fire time once the file is gone (COR-1667)', async () => {
    const { bureau, put, directory, observed } = await start({
      overrides: { durable: true },
    });
    await put('researcher.md', RESEARCHER);
    await bureau.agents.refresh();

    const refusal = await rejectionOf(
      bureau.schedules.create({ agentName: 'ghost', input: 'x', spec: '1m' }),
    );
    expect(refusal).toBeInstanceOf(UnknownScheduleAgentError);
    expect((refusal as UnknownScheduleAgentError).agentName).toBe('ghost');

    const created = await bureau.schedules.create({
      agentName: 'researcher',
      input: 'x',
      spec: '1m',
    });
    expect(created?.status).toBe('active');
    const occurrence = created?.nextFireAt;
    if (occurrence === null || occurrence === undefined) throw new Error('no first occurrence');

    await rm(join(directory, 'researcher.md'));
    await bureau.agents.refresh();
    expect(bureau.agents.find('researcher')).toBeUndefined();

    await bureau.maintain(occurrence);
    const status = await pollUntil(async () => {
      const page = await bureau.tasks.workflows();
      const fire = page?.items.find((item) => item.status !== 'running');
      return fire?.status;
    }, 'the fire to settle');
    // The fire was refused at fire time, as before: it failed, and the missing agent never generated.
    expect(status).toBe('failed');
    expect(observed).toEqual([]);
  });

  it('records the snapshot under the file hash, and lists revisions newest first', async () => {
    const { bureau, put } = await start();
    await put('researcher.md', RESEARCHER);
    await bureau.agents.refresh();
    const first = bureau.agents.list().find((listing) => listing.id === 'researcher');
    await runTask(bureau, 'researcher', 'one');

    await put('researcher.md', agentFileText({ model: OTHER_MODEL }, 'Second version.\n'));
    await bureau.agents.refresh();
    const second = bureau.agents.list().find((listing) => listing.id === 'researcher');
    await runTask(bureau, 'researcher', 'two');

    expect(first?.definitionHash).not.toBe(second?.definitionHash);
    const revisions = await bureau.agents.revisions('researcher');
    expect(revisions.map((revision) => revision.hash)).toEqual([
      second?.definitionHash ?? '',
      first?.definitionHash ?? '',
    ]);
    expect(revisions[0]?.definition.instructions).toBe('Second version.\n');
    expect(revisions[1]?.definition.instructions).toBe('You are a careful researcher.\n');
    expect(await bureau.agents.revisions('alpha')).toEqual([]);
  });

  it('stores one snapshot for runs on the same file', async () => {
    const { bureau, put } = await start();
    await put('researcher.md', RESEARCHER);
    await bureau.agents.refresh();
    await runTask(bureau, 'researcher', 'one');
    await runTask(bureau, 'researcher', 'two');
    expect(await bureau.agents.revisions('researcher')).toHaveLength(1);
  });

  it('keeps running the definition it started with when the file is edited mid-run', async () => {
    const gate = gated('first answer');
    const { bureau, put, observed } = await start({
      scripts: { [OPUS_5_5]: gate.script, [OPUS_5]: () => 'edited answer' },
    });
    await put('researcher.md', RESEARCHER);
    await bureau.agents.refresh();
    const midRun = await bureau.tasks.start('researcher', 'hello');
    await gate.started;

    await put('researcher.md', agentFileText({ model: OTHER_MODEL }, 'Edited instructions.\n'));
    await bureau.agents.refresh();
    const after = await bureau.tasks.start('researcher', 'hello again');
    expect(await taskContent(after)).toBe('edited answer');

    gate.release();
    expect(await taskContent(midRun)).toBe('first answer');
    expect(observed.map((seen) => [seen.model, seen.systemPrompt])).toEqual([
      [OPUS_5_5, 'You are a careful researcher.'],
      [OPUS_5, 'Edited instructions.'],
    ]);
  });

  it('keeps running the definition it started with when the file is deleted mid-run', async () => {
    const gate = gated('survived');
    const { bureau, put, directory } = await start({ scripts: { [OPUS_5_5]: gate.script } });
    await put('researcher.md', RESEARCHER);
    await bureau.agents.refresh();
    const midRun = await bureau.tasks.start('researcher', 'hello');
    await gate.started;

    await rm(join(directory, 'researcher.md'));
    await bureau.agents.refresh();
    expect(bureau.agents.list().some((listing) => listing.id === 'researcher')).toBe(false);

    gate.release();
    expect(await taskContent(midRun)).toBe('survived');
  });
});

describe('a session run of a file agent', () => {
  it('runs with the same options as bureau.run, and records the hash on the session', async () => {
    // `wakeup: false`: a session run is also offered `scheduleWakeup`, which a catalog run is not.
    const harness = await start({
      scripts: { [OPUS_5_5]: () => 'reply' },
      overrides: { wakeup: false },
    });
    const { bureau, put, observed } = harness;
    await put('researcher.md', RESEARCHER);
    await bureau.agents.refresh();

    await runTask(bureau, 'researcher', 'hello');
    const created = await bureau.tasks.start('researcher', 'hello');
    await waitForTaskState(bureau, created.id);

    const [catalogRun, sessionRun] = observed as [Observation, Observation];
    expect(sessionRun).toEqual(catalogRun);
    expect(sessionRun.systemPrompt).toBe('You are a careful researcher.');
    expect(sessionRun.tools).toEqual(['lookup-order', 'requestHumanInput']);

    const hash = bureau.agents
      .list()
      .find((listing) => listing.id === 'researcher')?.definitionHash;
    const session = await bureau.contexts.get(created.contextId);
    expect(session?.metadata['lastAgentDefinitionHash']).toBe(hash);
    expect(session?.agentName).toBe('researcher');
    const revisions = await bureau.agents.revisions('researcher');
    expect(revisions.map((revision) => revision.hash)).toEqual([hash ?? '']);
  });

  it('releases its snapshot reference when its session save loses to another agent binding the session', async () => {
    const { bureau, put } = await start({ scripts: { [OPUS_5_5]: () => 'reply' } });
    await put('alpha-file.md', agentFileText({ model: KNOWN_MODEL }, 'Alpha.\n'));
    await put('bravo-file.md', agentFileText({ model: KNOWN_MODEL }, 'Bravo.\n'));
    await bureau.agents.refresh();

    // Both pass the preflight check for a session that does not exist yet; one binds it first.
    const outcomes = await Promise.allSettled(
      ['alpha-file', 'bravo-file'].map((agentName) =>
        bureau.tasks.start(agentName, 'hello', { contextId: 'session-shared' }),
      ),
    );
    expect(outcomes.map((outcome) => outcome.status).toSorted()).toEqual(['fulfilled', 'rejected']);
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') await waitForTaskState(bureau, outcome.value.id);
    }

    // The loser kept no reference, and with it no snapshot; the winner's run holds its own.
    const kept = [
      ...(await bureau.agents.revisions('alpha-file')),
      ...(await bureau.agents.revisions('bravo-file')),
    ];
    expect(kept).toHaveLength(1);
  });

  it('is refused with NOT_FOUND for an invalid file, before anything is persisted', async () => {
    const { bureau, put } = await start();
    await put('broken.md', agentFileText({ model: 'anthropic/none' }));
    await bureau.agents.refresh();
    const refusal = await rejectionOf(
      bureau.tasks.start('broken', 'hello', { contextId: 'session-broken' }),
    );
    expect(refusal).toBeInstanceOf(BureauError);
    expect((refusal as BureauError).code).toBe('NOT_FOUND');
    expect(await bureau.contexts.list()).toEqual([]);
  });
});

describe('createBureau with an agent directory', () => {
  it('lists code-defined and file agents together', async () => {
    const { bureau, put } = await start();
    await put('researcher.md', RESEARCHER);
    await put('broken.md', agentFileText({ model: 'anthropic/none' }));
    await bureau.agents.refresh();
    expect(
      bureau.agents.list().map((listing) => [listing.id, listing.source, listing.state]),
    ).toEqual([
      ['alpha', 'code', 'ready'],
      ['broken', 'file', 'invalid'],
      ['researcher', 'file', 'ready'],
    ]);
    expect(bureau.agents.names()).toEqual(['alpha']);
  });

  it('loads the files that are already there before it returns', async () => {
    const first = await start();
    await first.put('early.md', RESEARCHER);
    const second = await start({ directory: first.directory });
    expect(second.bureau.agents.list().map((listing) => listing.id)).toEqual(['alpha', 'early']);
  });

  it('refuses a directory without the means to run its models', async () => {
    const { createBureau } = await import('./create-bureau');
    const refusal = await rejectionOf(
      createBureau({ agents: {}, agentSource: agentFileDirectory('/tmp/agents') }),
    );
    expect(refusal).toBeInstanceOf(BureauError);
    expect((refusal as BureauError).code).toBe('BAD_REQUEST');
  });

  it('has no file agents and refuses the write API without a directory', async () => {
    const { createBureau } = await import('./create-bureau');
    const bureau = await createBureau({ agents: {} });
    try {
      expect(bureau.agents.list()).toEqual([]);
      const refusal = await rejectionOf(
        bureau.agents.create('x', { model: KNOWN_MODEL, instructions: '' }),
      );
      expect(refusal).toMatchObject({ code: 'agent-directory-not-configured' });
    } finally {
      await bureau.dispose();
    }
  });

  it('writes an agent through the API that then runs', async () => {
    const { bureau } = await start({ scripts: { [OPUS_5_5]: () => 'created and run' } });
    await bureau.agents.create('writer', { model: KNOWN_MODEL, instructions: 'Write.\n' });
    const result = await runTask(bureau, 'writer', 'go');
    expect(result.content).toBe('created and run');
  });
});
