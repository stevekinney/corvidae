/**
 * COR-2533: `interborough runs explain` and `runs retry` against a real Bureau and its handler, the
 * fixture host. A failed workflow instance and a failed agent run are explained as text and as the
 * operation's own result; a run that did not fail is the server's message and remediation with the
 * usage exit status; every command line the explanation returns runs against the host, the retry
 * last, because it changes the run.
 */
import { createAgent } from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  serveWorkflows,
  type Served,
} from '../../../../packages/bureau/src/http/management/workflows-fixtures.test-support.ts';
import {
  AGENT_STEP,
  FAST_SCHEDULE,
} from '../../../../packages/bureau/src/testing/workflow-file-fixtures.test-support.ts';
import type { CliClientDependencies } from './cli-client.ts';
import { executeCliWithDispatchAssertions as executeCli } from './cli-dispatch.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const control = { writerDown: true };

/** A Bureau whose writer fails while `control.writerDown`, serving the CLI's requests in process. */
async function fixtureHost(): Promise<{ served: Served; dependencies: CliClientDependencies }> {
  control.writerDown = true;
  const served = await serveWorkflows(cleanups, {
    onDiagnostic: () => undefined,
    agents: {
      writer: createAgent({
        name: 'writer',
        generate: async () => {
          if (control.writerDown) throw new Error('the writer is down');
          return { content: 'written', toolCalls: [] };
        },
      }),
    },
  });
  await served.bureau.workflows!.create('digest', {
    agent: 'writer',
    trigger: FAST_SCHEDULE,
    steps: [AGENT_STEP],
  });
  return {
    served,
    // The CLI posts to `/bureau/jsonrpc`; the handler serves `/jsonrpc`, as the host mounts it.
    dependencies: {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        url.pathname = url.pathname.replace(/^\/bureau/, '') || '/';
        return served.owner(new Request(url, init));
      },
    },
  };
}

/** The status the Bureau holds of the instance `runId` of the `digest` workflow. */
async function instanceStatus(served: Served, runId: string): Promise<string | undefined> {
  const run = await served.bureau.workflows!.getRun(runId);
  return run?.status;
}

async function failedInstance(served: Served, runId: string): Promise<void> {
  await served.bureau.durableEngine()!.start('digest', null, { id: runId });
  await waitUntil(async () => (await instanceStatus(served, runId)) === 'failed', {
    message: `workflow run ${runId} failed`,
  });
}

async function failedTask(served: Served): Promise<string> {
  const handle = await served.bureau.tasks.start('writer', 'go');
  await waitUntil(
    async () => {
      const task = await served.bureau.tasks.get(handle.id);
      return task?.status === 'failed';
    },
    { message: `task ${handle.id} failed` },
  );
  await served.bureau.internals.taskRegistry.flush();
  return handle.id;
}

/** The arguments of an `interborough ...` command line made only of plain words. */
function argumentsOf(commandLine: string): string[] {
  const words = commandLine.split(' ');
  expect(words[0]).toBe('interborough');
  expect(commandLine).not.toMatch(/['"\\;|&$]/u);
  return words.slice(1);
}

describe('interborough runs explain', () => {
  // spawn-free: the CLI runs in this process against a real Bureau handler.
  test('AC4: explains a failed workflow instance as text and as the operation’s result', async () => {
    const { served, dependencies } = await fixtureHost();
    await failedInstance(served, 'failed-digest');

    const text = await executeCli(['runs', 'explain', 'failed-digest'], dependencies);
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toBe('');
    expect(text.stdout).toStartWith('The step ');
    expect(text.stdout).toContain('Cause: application');
    expect(text.stdout).toContain('Tries: ');
    expect(text.stdout).toContain('Next: ');
    expect(text.stdout).toContain('  interborough runs get --kind workflow failed-digest');
    expect(text.stdout).not.toContain('the writer is down');

    const json = await executeCli(
      ['runs', 'explain', 'failed-digest', '--output', 'json'],
      dependencies,
    );
    expect(json.exitCode).toBe(0);
    const envelope = JSON.parse(json.stdout) as { data: Record<string, unknown> };
    expect(Object.keys(envelope.data).toSorted()).toEqual(
      ['cause', 'nextCommands', 'remediation', 'step', 'summary', 'tries', 'verdicts'].toSorted(),
    );
    expect(envelope.data['summary']).toBe(text.stdout.split('\n')[0]!);
    // The text and the data say the same thing.
    expect(envelope.data['nextCommands']).toEqual([
      'interborough runs get --kind workflow failed-digest',
      'interborough runs retry failed-digest',
    ]);
  });

  // spawn-free: the CLI runs in this process against a real Bureau handler.
  test('AC4: explains a failed agent run, named with or without its kind prefix', async () => {
    const { served, dependencies } = await fixtureHost();
    const taskId = await failedTask(served);

    const bare = await executeCli(['runs', 'explain', taskId, '--output', 'json'], dependencies);
    const prefixed = await executeCli(
      ['runs', 'explain', `task:${taskId}`, '--output', 'json'],
      dependencies,
    );
    expect(bare.exitCode).toBe(0);
    expect(JSON.parse(prefixed.stdout)).toEqual(JSON.parse(bare.stdout));
    const data = (JSON.parse(bare.stdout) as { data: { nextCommands: string[] } }).data;
    expect(data.nextCommands).toEqual([`interborough runs get --kind task ${taskId}`]);
  });

  // spawn-free: the CLI runs in this process against a real Bureau handler.
  test('AC5: a run that did not fail prints the server’s message and remediation, exit 2', async () => {
    const { served, dependencies } = await fixtureHost();
    control.writerDown = false;
    await served.bureau.durableEngine()!.start('digest', null, { id: 'ok-digest' });
    await waitUntil(async () => (await instanceStatus(served, 'ok-digest')) === 'completed', {
      message: 'the digest completes',
    });

    const text = await executeCli(['runs', 'explain', 'ok-digest'], dependencies);
    expect(text.exitCode).toBe(2);
    expect(text.stdout).toBe('');
    expect(text.stderr).toContain('has not failed');
    expect(text.stderr).toContain('"completed"');
    expect(text.stderr).toContain('\nTry: Explain a run only after it has failed');

    const json = await executeCli(
      ['runs', 'explain', 'ok-digest', '--output', 'json'],
      dependencies,
    );
    expect(json.exitCode).toBe(2);
    expect(JSON.parse(json.stdout)).toMatchObject({
      error: {
        code: 'Unprocessable',
        exitCode: 2,
        message: expect.stringContaining('has not failed'),
        remediation: expect.stringContaining('Explain a run only after it has failed'),
      },
    });
  });

  // spawn-free: the CLI runs in this process against a real Bureau handler.
  test('a run that does not exist is the server’s not-found, not a usage error', async () => {
    const { dependencies } = await fixtureHost();
    const result = await executeCli(['runs', 'explain', 'no-such-run'], dependencies);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no-such-run');
  });
});

describe('interborough runs retry', () => {
  // spawn-free: the CLI runs in this process against a real Bureau handler.
  test('AC6: runs a failed instance again from the step it failed at, and the run completes', async () => {
    const { served, dependencies } = await fixtureHost();
    await failedInstance(served, 'retried-digest');
    control.writerDown = false;

    const result = await executeCli(
      ['runs', 'retry', 'retried-digest', '--output', 'json'],
      dependencies,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({
      kind: 'workflow',
      id: 'workflow:retried-digest',
      runId: 'retried-digest',
      step: 1,
    });
    await waitUntil(async () => (await instanceStatus(served, 'retried-digest')) === 'completed', {
      message: 'the retried run completes',
    });
  });

  // spawn-free: the CLI runs in this process against a real Bureau handler.
  test('AC6: names the step with --step, and refuses one the instance did not fail at', async () => {
    const { served, dependencies } = await fixtureHost();
    await failedInstance(served, 'stepped-digest');

    const wrong = await executeCli(
      ['runs', 'retry', 'stepped-digest', '--step', '2'],
      dependencies,
    );
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stderr).toContain('no step 2');
    expect(await instanceStatus(served, 'stepped-digest')).toBe('failed');

    control.writerDown = false;
    const right = await executeCli(
      ['runs', 'retry', 'stepped-digest', '--step', '1'],
      dependencies,
    );
    expect(right.exitCode).toBe(0);
  });

  // spawn-free: the CLI runs in this process against a real Bureau handler.
  test('is refused for an agent run, and for an instance that is not failed', async () => {
    const { served, dependencies } = await fixtureHost();
    const task = await executeCli(['runs', 'retry', 'any', '--kind', 'task'], dependencies);
    expect(task.exitCode).toBe(2);
    control.writerDown = false;
    await served.bureau.durableEngine()!.start('digest', null, { id: 'fine-digest' });
    await waitUntil(async () => (await instanceStatus(served, 'fine-digest')) === 'completed', {
      message: 'the digest completes',
    });
    const completed = await executeCli(['runs', 'retry', 'fine-digest'], dependencies);
    expect(completed.exitCode).toBe(1);
    expect(completed.stderr).toContain('not failed');
  });
});

describe('the commands an explanation returns', () => {
  // spawn-free: the CLI runs in this process against a real Bureau handler.
  test('AC7: every command line it returns runs against the host, the retry last', async () => {
    const { served, dependencies } = await fixtureHost();
    await failedInstance(served, 'listed-digest');
    const explained = await executeCli(
      ['runs', 'explain', 'listed-digest', '--output', 'json'],
      dependencies,
    );
    const lines = (JSON.parse(explained.stdout) as { data: { nextCommands: string[] } }).data
      .nextCommands;
    // `runs retry` is offered for this instance, and it changes the run, so it goes after the reads.
    expect(lines).toContain('interborough runs retry listed-digest');
    const ordered = [
      ...lines.filter((line) => !line.startsWith('interborough runs retry')),
      ...lines.filter((line) => line.startsWith('interborough runs retry')),
    ];

    control.writerDown = false;
    for (const line of ordered) {
      const result = await executeCli(argumentsOf(line), dependencies);
      expect([line, result.exitCode, result.stderr]).toEqual([line, 0, '']);
    }
    await waitUntil(async () => (await instanceStatus(served, 'listed-digest')) === 'completed', {
      message: 'the retried run completes',
    });
  });

  // spawn-free: the CLI runs in this process against a real Bureau handler.
  test('AC7: offers no retry for an agent run, and its one command runs', async () => {
    const { served, dependencies } = await fixtureHost();
    const taskId = await failedTask(served);
    const explained = await executeCli(
      ['runs', 'explain', taskId, '--output', 'json'],
      dependencies,
    );
    const lines = (JSON.parse(explained.stdout) as { data: { nextCommands: string[] } }).data
      .nextCommands;
    expect(lines.some((line) => line.includes('runs retry'))).toBe(false);
    for (const line of lines) {
      const result = await executeCli(argumentsOf(line), dependencies);
      expect([line, result.exitCode]).toEqual([line, 0]);
    }
  });
});
