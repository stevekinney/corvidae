/**
 * COR-1524 — a file agent runs like a code-defined one, through `bureau.run` and through a session
 * run, with the same options. A run uses the definition it started with: editing or deleting the
 * file mid-run does not change it, and the snapshot is recorded under the file's hash.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { MemoryStorage } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { BureauError, UnknownScheduleAgentError } from './create-bureau';
import { waitForRunState } from './test';
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
import { AGENT_RUN_REFERENCE_KEY_PREFIX } from './agent-snapshot-store';
import { pollUntil } from './schedule-fire-fixtures.test-support';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';

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

describe('bureau.run of a file agent', () => {
  it('runs the agent the file describes: its model, tools, and instructions', async () => {
    const { bureau, put, observed } = await start({ scripts: { [OPUS_5_5]: () => 'file reply' } });
    await put('researcher.md', RESEARCHER);
    await bureau.agents.refresh();
    const run = bureau.run('researcher', 'hello');
    const result = await run.result();
    expect(result.finishReason).toBe('stop-condition');
    expect(await run.unwrap()).toBe('file reply');
    expect(observed).toEqual([
      {
        model: OPUS_5_5,
        tools: ['lookup-order'],
        systemPrompt: 'You are a careful researcher.',
      },
    ]);
  });

  it('still runs a code-defined agent by its key, with its precise type', async () => {
    const { bureau } = await start();
    const run = bureau.run('alpha', 'hello');
    expect(await run.unwrap()).toBe('alpha');
  });

  it('is refused with NOT_FOUND for a name no agent has, and for a file that is invalid', async () => {
    const { bureau, put } = await start();
    await put('broken.md', agentFileText({ model: 'anthropic/none' }));
    await bureau.agents.refresh();
    for (const name of ['ghost', 'broken']) {
      let thrown: unknown;
      try {
        bureau.run(name, 'hello');
      } catch (error) {
        thrown = error;
      }
      expect(thrown, name).toBeInstanceOf(BureauError);
      expect((thrown as BureauError).code).toBe('NOT_FOUND');
    }
  });

  it('schedules a file agent, refuses a name no agent has, and still fails at fire time once the file is gone (COR-1667)', async () => {
    const { bureau, put, directory, observed } = await start({
      overrides: { durableExecution: true },
    });
    await put('researcher.md', RESEARCHER);
    await bureau.agents.refresh();

    const refusal = await rejectionOf(
      bureau.createSchedule({ agentName: 'ghost', input: 'x', spec: '1m' }),
    );
    expect(refusal).toBeInstanceOf(UnknownScheduleAgentError);
    expect((refusal as UnknownScheduleAgentError).agentName).toBe('ghost');

    const created = await bureau.createSchedule({
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

    await bureau.runDurableMaintenance(occurrence);
    const status = await pollUntil(async () => {
      const page = await bureau.listDurableRuns();
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
    await bureau.run('researcher', 'one').result();

    await put('researcher.md', agentFileText({ model: OTHER_MODEL }, 'Second version.\n'));
    await bureau.agents.refresh();
    const second = bureau.agents.list().find((listing) => listing.id === 'researcher');
    await bureau.run('researcher', 'two').result();

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
    await bureau.run('researcher', 'one').result();
    await bureau.run('researcher', 'two').result();
    expect(await bureau.agents.revisions('researcher')).toHaveLength(1);
  });

  it('keeps running the definition it started with when the file is edited mid-run', async () => {
    const gate = gated('first answer');
    const { bureau, put, observed } = await start({
      scripts: { [OPUS_5_5]: gate.script, [OPUS_5]: () => 'edited answer' },
    });
    await put('researcher.md', RESEARCHER);
    await bureau.agents.refresh();
    const midRun = bureau.run('researcher', 'hello');
    await gate.started;

    await put('researcher.md', agentFileText({ model: OTHER_MODEL }, 'Edited instructions.\n'));
    await bureau.agents.refresh();
    const after = bureau.run('researcher', 'hello again');
    expect(await after.unwrap()).toBe('edited answer');

    gate.release();
    expect(await midRun.unwrap()).toBe('first answer');
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
    const midRun = bureau.run('researcher', 'hello');
    await gate.started;

    await rm(join(directory, 'researcher.md'));
    await bureau.agents.refresh();
    expect(bureau.agents.list().some((listing) => listing.id === 'researcher')).toBe(false);

    gate.release();
    expect(await midRun.unwrap()).toBe('survived');
  });
});

describe('a scheduler task of a file agent', () => {
  it('runs the definition it was submitted under when the file is edited before it dispatches (COR-1662)', async () => {
    const gate = gated('first answer');
    const { bureau, put, observed } = await start({
      scripts: { [OPUS_5_5]: gate.script, [OPUS_5]: () => 'edited answer' },
      overrides: { scheduler: { enabled: true, idleDelay: 1 } },
    });
    await put('researcher.md', RESEARCHER);
    await bureau.agents.refresh();

    // The first task holds the scheduler's one slot, so the second waits in the queue.
    const first = await bureau.submitSchedulerTask({ agentName: 'researcher', message: 'one' });
    await gate.started;
    const second = await bureau.submitSchedulerTask({ agentName: 'researcher', message: 'two' });

    await put('researcher.md', agentFileText({ model: OTHER_MODEL }, 'Edited instructions.\n'));
    await bureau.agents.refresh();
    // A task submitted after the edit takes the edited definition: only the queued one is pinned.
    const third = await bureau.submitSchedulerTask({ agentName: 'researcher', message: 'three' });

    gate.release();
    for (const task of [first, second, third]) await bureau.awaitSchedulerTask(task.taskId);
    // OPUS_5_5's script holds the gate, so the first two both ran the original model.
    expect(observed.map((seen) => [seen.model, seen.systemPrompt])).toEqual([
      [OPUS_5_5, 'You are a careful researcher.'],
      [OPUS_5_5, 'You are a careful researcher.'],
      [OPUS_5, 'Edited instructions.'],
    ]);
  });
});

describe('a scheduler task whose definition cannot be pinned', () => {
  it('is refused before it is queued, and holds neither a flow-control slot nor a reference (COR-1662)', async () => {
    // A backing store that refuses the write that ties a run to its definition, once armed.
    let failReferences = false;
    class ReferenceRefusingStorage extends MemoryStorage {
      override async put(key: string, value: Uint8Array): Promise<void> {
        if (failReferences && key.includes(AGENT_RUN_REFERENCE_KEY_PREFIX)) {
          throw new Error('reference write refused');
        }
        await super.put(key, value);
      }
    }
    const storage = new ReferenceRefusingStorage();
    const { bureau, put, observed } = await start({
      scripts: { [OPUS_5_5]: () => 'pinned answer' },
      overrides: {
        storage,
        scheduler: { enabled: true, idleDelay: 1 },
        flowControl: { concurrency: { limit: 1 } },
      },
    });
    await put('researcher.md', RESEARCHER);
    await bureau.agents.refresh();

    failReferences = true;
    const refusal = await rejectionOf(
      bureau.submitSchedulerTask({ agentName: 'researcher', message: 'one' }),
    );
    expect((refusal as Error).message).toContain('reference write refused');
    expect(observed).toEqual([]);

    // The slot the refused submission took was given back: the next submission is admitted, runs, and
    // is pinned.
    failReferences = false;
    const next = await bureau.submitSchedulerTask({ agentName: 'researcher', message: 'two' });
    expect(await bureau.awaitSchedulerTask(next.taskId)).not.toBeNull();
    expect(observed.map((seen) => seen.model)).toEqual([OPUS_5_5]);
  });
});

describe('a session run of a file agent', () => {
  it('runs with the same options as bureau.run, and records the hash on the session', async () => {
    const harness = await start({ scripts: { [OPUS_5_5]: () => 'reply' } });
    const { bureau, put, observed } = harness;
    await put('researcher.md', RESEARCHER);
    await bureau.agents.refresh();

    await bureau.run('researcher', 'hello').result();
    const created = await bureau.createRun({ message: 'hello', agentName: 'researcher' });
    await waitForRunState(bureau, created.id);

    const [catalogRun, sessionRun] = observed as [Observation, Observation];
    expect(sessionRun).toEqual(catalogRun);
    expect(sessionRun.systemPrompt).toBe('You are a careful researcher.');
    expect(sessionRun.tools).toEqual(['lookup-order']);

    const hash = bureau.agents
      .list()
      .find((listing) => listing.id === 'researcher')?.definitionHash;
    const session = await bureau.getSession(created.sessionId);
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
        bureau.createRun({ message: 'hello', agentName, sessionId: 'session-shared' }),
      ),
    );
    expect(outcomes.map((outcome) => outcome.status).toSorted()).toEqual(['fulfilled', 'rejected']);
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') await waitForRunState(bureau, outcome.value.id);
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
      bureau.createRun({ message: 'hello', agentName: 'broken', sessionId: 'session-broken' }),
    );
    expect(refusal).toBeInstanceOf(BureauError);
    expect((refusal as BureauError).code).toBe('NOT_FOUND');
    expect(await bureau.listSessions()).toEqual([]);
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
    const refusal = await rejectionOf(createBureau({ agents: {}, agentDirectory: '/tmp/agents' }));
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
    expect(await bureau.run('writer', 'go').unwrap()).toBe('created and run');
  });
});
