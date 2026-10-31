/**
 * COR-1811 — the host keeps the `ctx.log` lines of a workflow with its run: they are served through
 * the engine API per run and per step, they are there after the run ends and after the host restarts,
 * and the Bureau starts with the 7-day window and 500-line cap the Settings page can change.
 */
import { workflow, type Engine, type WorkflowContext } from '@lostgradient/weft';
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  startHost,
  WORKFLOW_LOG_MAXIMUM_LINES_PER_RUN,
  WORKFLOW_LOG_RETENTION_MILLISECONDS,
  type Host,
} from './host.ts';

const DAY = 24 * 60 * 60 * 1000;
const directories: string[] = [];
const hosts: Host[] = [];

// With no `onLog` sink the host still prints each line to the console, as it did before lines were kept.
const consoleSpies: Array<Mock<(...data: unknown[]) => void>> = [];

beforeEach(() => {
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    consoleSpies.push(spyOn(console, level).mockImplementation(() => undefined));
  }
});

afterEach(async () => {
  for (const spy of consoleSpies.splice(0)) spy.mockRestore();
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function start(home: string): Promise<Host> {
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
  hosts.push(host);
  return host;
}

async function closeHost(host: Host): Promise<void> {
  hosts.splice(hosts.indexOf(host), 1);
  await host.close();
}

const noop = async () => null;

const loggingWorkflow = workflow({ name: 'host-logged' }).execute(async function* (
  ctx: WorkflowContext,
) {
  ctx.log?.info('starting', { attempt: 1 });
  yield* ctx.run(noop);
  ctx.log?.warn('halfway');
  yield* ctx.run(noop);
  ctx.log?.error('finished');
  return 'done';
});

describe('the host’s workflow logs', () => {
  test('starts with a 7-day window and a 500-line cap, which the Settings page can replace', async () => {
    const home = await mkdtemp(join(tmpdir(), 'interborough-logs-defaults-'));
    directories.push(home);
    const host = await start(home);

    const snapshot = await host.bureau.settings.get();
    expect(WORKFLOW_LOG_RETENTION_MILLISECONDS).toBe(7 * DAY);
    expect(WORKFLOW_LOG_MAXIMUM_LINES_PER_RUN).toBe(500);
    expect(snapshot.values['retention.logs']).toEqual({ olderThan: 7 * DAY });
    expect(snapshot.values['logs.maximumLinesPerRun']).toBe(500);

    const updated = await host.bureau.settings.update(
      { 'retention.logs': { olderThan: DAY }, 'logs.maximumLinesPerRun': 50 },
      { expectedRevision: snapshot.revision },
    );
    expect(updated.outcome).toBe('applied');
    const after = await host.bureau.settings.get();
    expect(after.values['retention.logs']).toEqual({ olderThan: DAY });
    expect(after.values['logs.maximumLinesPerRun']).toBe(50);
  });

  test('serves a finished run’s lines per run and per step over the engine API, and after a restart', async () => {
    const home = await mkdtemp(join(tmpdir(), 'interborough-logs-run-'));
    directories.push(home);
    const first = await start(home);
    const engine = first.engine as Engine;
    engine.register(loggingWorkflow);
    const handle = await engine.start('host-logged', null, { id: 'logged-run' });
    await handle.result();

    const response = await fetch(new URL('/v1/workflows/logged-run/logs', first.url));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      lines: Array<{ step: number; level: string; message: string }>;
      dropped: number;
    };
    expect(body.dropped).toBe(0);
    expect(body.lines.map((line) => [line.step, line.level, line.message])).toEqual([
      [0, 'info', 'starting'],
      [1, 'warn', 'halfway'],
      [2, 'error', 'finished'],
    ]);
    const stepResponse = await fetch(new URL('/v1/workflows/logged-run/logs?step=1', first.url));
    const stepBody = (await stepResponse.json()) as { lines: Array<{ message: string }> };
    expect(stepBody.lines.map((line) => line.message)).toEqual(['halfway']);

    await closeHost(first);
    const second = await start(home);
    const afterRestart = await second.engine.getLogs('logged-run');
    expect(afterRestart.lines.map((line) => line.message)).toEqual([
      'starting',
      'halfway',
      'finished',
    ]);
  });
});
