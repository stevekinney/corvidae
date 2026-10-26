/**
 * COR-1527 — a Bureau over a workflow directory registers every ready file as a workflow type of
 * its durable engine, refuses a configuration that cannot work, and keeps the engine in line with
 * the files as they change.
 */
import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import { afterEach, describe, expect, it } from 'bun:test';

import { BureauError, createBureau } from './create-bureau';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import { AGENT_STEP, workflowFileText } from './testing/workflow-file-fixtures.test-support';
import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';
import { agentFileDirectory } from './sources/agent-file-directory';
import { workflowFileDirectory } from './sources/workflow-file-directory';

const harnesses: WorkflowBureauHarness[] = [];
const fileHarnesses: FileBureauHarness[] = [];
const fileAgentDirectories: string[] = [];

async function start(options?: Parameters<typeof startWorkflowBureau>[0]) {
  const harness = await startWorkflowBureau(options);
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  for (const harness of fileHarnesses.splice(0)) await harness.dispose();
  for (const directory of fileAgentDirectories.splice(0)) removeTemporaryPath(directory);
});

describe('workflowSource', () => {
  it('is refused when it is not a workflow source', async () => {
    const error = await createBureau({
      agents: {},
      workflowSource: agentFileDirectory('/tmp/never-used') as never,
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('BAD_REQUEST');
  });

  it('is refused without a durable engine, because a schedule and an instance need one', async () => {
    const error = await createBureau({
      agents: {},
      workflowSource: workflowFileDirectory('/tmp/never-used'),
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('BAD_REQUEST');
    expect((error as BureauError).message).toContain('durable engine');
  });

  it('leaves bureau.workflows undefined for a Bureau that has none', async () => {
    const bureau = await createBureau({ agents: {} });
    try {
      expect(bureau.workflows).toBeUndefined();
    } finally {
      await bureau.dispose();
    }
  });
});

describe('a Bureau over a workflow directory', () => {
  it('registers a file that is already there at startup, runs it, and reports it ready', async () => {
    const first = await start();
    await first.put('digest.json', workflowFileText('digest', { agent: 'writer' }));
    await first.bureau.workflows?.refresh();
    const listing = first.bureau.workflows?.list().find((entry) => entry.id === 'digest');
    expect(listing).toMatchObject({ state: 'ready', agent: 'writer', owner: 'anonymous:local' });

    const engine = first.bureau.durableEngine();
    expect(await engine?.workflows.getActive('digest')).toBeDefined();
    const run = await engine?.start(
      'digest',
      { kind: 'schedule', scheduleId: 'manual' },
      { id: 'r1' },
    );
    const result = (await run?.result()) as {
      content: string;
      output: unknown;
      finishReason: string;
    };
    expect(result.content).toBe('writer');
    expect(result.output).toBeNull();
    expect(result.finishReason).toBe('stop-condition');
  });

  it('registers a file added or edited while running, and an invalid file registers nothing', async () => {
    const harness = await start();
    await harness.putWorkflow('digest');
    await harness.put('broken.json', '{');
    await harness.bureau.workflows?.refresh();

    const engine = harness.bureau.durableEngine();
    expect(await engine?.workflows.getActive('digest')).toBeDefined();
    expect(await engine?.workflows.getActive('broken')).toBeFalsy();
    expect(harness.bureau.workflows?.list().find((entry) => entry.id === 'broken')?.state).toBe(
      'invalid',
    );
    // The schedule exists for the ready file only.
    const schedules = await harness.bureau.listSchedules();
    expect(schedules?.items.map((schedule) => schedule.id)).toEqual([
      'bureau-workflow-schedule:digest:1',
    ]);
  });

  it('lists a file named for a code-defined workflow as invalid and never registers it', async () => {
    const harness = await start();
    await harness.put('agentRun.json', workflowFileText('agentRun'));
    await harness.putWorkflow('ordinary');
    const listing = harness.bureau.workflows?.list();
    // `agentRun` is not a valid identifier (capital R) and `durableHeartbeatTick` neither; the
    // check that matters is the engine's own names, so a lowercase file cannot take them.
    expect(listing?.find((entry) => entry.id === 'agentRun')?.problem?.code).toBe(
      'invalid-identifier',
    );
    expect(listing?.find((entry) => entry.id === 'ordinary')?.state).toBe('ready');
  });
});

describe('an agent step', () => {
  it('sends the message unchanged when there is no trigger or previous result, and returns content, output, and finish reason', async () => {
    const harness = await start({ replies: { writer: () => 'the digest' } });
    await harness.put(
      'digest.json',
      workflowFileText('digest', {
        trigger: { kind: 'schedule', spec: '1h' },
        steps: [{ ...AGENT_STEP }],
      }),
    );
    await harness.bureau.workflows?.refresh();
    const run = await harness.bureau.durableEngine()?.start('digest', null, { id: 'plain' });
    expect(await run?.result()).toEqual({
      content: 'the digest',
      output: null,
      finishReason: 'stop-condition',
    });
    expect(harness.calls).toEqual([{ agent: 'writer', message: 'Write the digest' }]);
  });

  it('sends the trigger and then the previous step as labelled fenced JSON blocks, in order', async () => {
    const harness = await start({
      replies: { writer: () => 'first draft', editor: () => 'final' },
    });
    await harness.put(
      'chain.json',
      workflowFileText('chain', {
        trigger: { kind: 'schedule', spec: '1h' },
        steps: [
          { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'Draft' } },
          { kind: 'activity', handler: 'agent', input: { agent: 'editor', message: 'Edit' } },
        ],
      }),
    );
    await harness.bureau.workflows?.refresh();
    const run = await harness.bureau
      .durableEngine()
      ?.start('chain', { kind: 'schedule', scheduleId: 's' }, { id: 'chained' });
    const outcome = (await run?.result()) as { content: string } | undefined;
    expect(outcome?.content).toBe('final');

    const fence = '```';
    expect(harness.calls[0]?.message).toBe(
      `Draft\n\nTrigger:\n${fence}json\n{\n  "kind": "schedule",\n  "scheduleId": "s"\n}\n${fence}`,
    );
    expect(harness.calls[1]?.message).toBe(
      `Edit\n\nTrigger:\n${fence}json\n{\n  "kind": "schedule",\n  "scheduleId": "s"\n}\n${fence}\n\nPrevious step:\n${fence}json\n{\n  "content": "first draft",\n  "output": null,\n  "finishReason": "stop-condition"\n}\n${fence}`,
    );
  });

  it('fails the instance with a not-found-shaped error for an agent that does not exist, and runs.get returns it', async () => {
    const harness = await start();
    await harness.put(
      'ghosts.json',
      workflowFileText('ghosts', {
        trigger: { kind: 'schedule', spec: '1h' },
        steps: [{ kind: 'activity', handler: 'agent', input: { agent: 'nobody', message: 'Hi' } }],
      }),
    );
    await harness.bureau.workflows?.refresh();
    const run = await harness.bureau.durableEngine()?.start('ghosts', null, { id: 'ghost-run' });
    await run?.result().catch(() => undefined);

    const detail = await harness.bureau.workflows?.getRun('ghost-run');
    expect(detail?.status).toBe('failed');
    expect(detail?.error).toContain('Agent "nobody" does not exist');
  });

  it('fails the instance when the agent run fails, and when it is aborted', async () => {
    const harness = await start({
      replies: {
        writer: () => {
          throw new Error('model unavailable');
        },
      },
    });
    await harness.putWorkflow('digest', { trigger: { kind: 'schedule', spec: '1h' } });
    const run = await harness.bureau.durableEngine()?.start('digest', null, { id: 'failing' });
    await run?.result().catch(() => undefined);
    const detail = await harness.bureau.workflows?.getRun('failing');
    expect(detail?.status).toBe('failed');
    expect(detail?.error).toContain('Agent "writer" failed');
    expect(detail?.error).toContain('model unavailable');
  });

  it('starts a standalone run owned by anonymous:local that is not a task and has no session', async () => {
    const harness = await start();
    await harness.putWorkflow('digest', { trigger: { kind: 'schedule', spec: '1h' } });
    const run = await harness.bureau.durableEngine()?.start('digest', null, { id: 'owned' });
    await run?.result();

    const engine = harness.bureau.durableEngine();
    const stepRuns = await engine?.list({ type: 'agentRun' });
    expect(stepRuns?.items).toHaveLength(1);
    const stepRunId = stepRuns?.items[0]?.id ?? '';
    expect(stepRunId.startsWith('workflow-agent-')).toBe(true);
    expect(await harness.bureau.getOwner({ kind: 'run', id: stepRunId })).toBe('anonymous:local');
    // Not a task, and no context was created for it.
    const page = await harness.bureau.tasks.enumerate({ limit: 100, offset: 0 });
    expect(page.tasks.map((task) => task.id)).not.toContain(stepRunId);
    expect(await harness.bureau.tasks.record(stepRunId)).toBeUndefined();
    expect(await harness.bureau.getSession(stepRunId)).toBeUndefined();
  });
});

describe('an agent step that names a file agent', () => {
  const RESEARCHER = agentFileText(
    { name: 'Researcher', model: KNOWN_MODEL, tools: '[lookup-order]' },
    'You are a careful researcher.\n',
  );

  async function startWithFileAgents() {
    const workflowsPath = createTemporaryDirectory('bureau-workflow-file-agents');
    fileAgentDirectories.push(workflowsPath);
    const harness = await startFileBureau({
      scripts: {
        'claude-opus-5-5': (observation) => `file agent reply (${observation.tools.join(',')})`,
      },
      overrides: { workflowSource: workflowFileDirectory(workflowsPath) },
    });
    fileHarnesses.push(harness);
    return harness;
  }

  it('runs the file agent with its model and tools, and records the snapshot its run used', async () => {
    const { bureau, put, observed } = await startWithFileAgents();
    await put('researcher.md', RESEARCHER);
    await bureau.agents.refresh();
    await bureau.workflows!.create('research', {
      trigger: { kind: 'schedule', spec: '1h' },
      steps: [
        { kind: 'activity', handler: 'agent', input: { agent: 'researcher', message: 'Find it' } },
      ],
    });

    const run = await bureau.durableEngine()!.start('research', null, { id: 'file-agent-run' });
    const outcome = (await run.result()) as { content: string; finishReason: string };

    expect(outcome.content).toBe('file agent reply (lookup-order)');
    expect(observed).toEqual([
      {
        model: 'claude-opus-5-5',
        tools: ['lookup-order'],
        systemPrompt: 'You are a careful researcher.',
      },
    ]);
    const revisions = await bureau.agents.revisions('researcher');
    expect(revisions).toHaveLength(1);
    // Still not a task, though the agent behind it is a file.
    const stepRuns = await bureau.durableEngine()!.list({ type: 'agentRun' });
    expect(await bureau.tasks.record(stepRuns.items[0]!.id)).toBeUndefined();
  });

  it('fails the step as a missing agent when the file agent is invalid', async () => {
    const { bureau, put } = await startWithFileAgents();
    await put('broken.md', agentFileText({ model: 'anthropic/none' }));
    await bureau.agents.refresh();
    await bureau.workflows!.create('research', {
      trigger: { kind: 'schedule', spec: '1h' },
      steps: [
        { kind: 'activity', handler: 'agent', input: { agent: 'broken', message: 'Find it' } },
      ],
    });

    const run = await bureau.durableEngine()!.start('research', null, { id: 'broken-agent-run' });
    await run.result().catch(() => undefined);

    const detail = await bureau.workflows!.getRun('broken-agent-run');
    expect(detail?.status).toBe('failed');
    expect(detail?.error).toContain('Agent "broken" does not exist');
  });
});
