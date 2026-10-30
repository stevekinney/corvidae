/**
 * COR-1811 — `BureauOptions.logs` keeps the `ctx.log` lines of durable workflows with their runs:
 * the lines are served by the durable engine per run and per step, `logs.maximumLinesPerRun` is read
 * on every line written, and `retention.logs` is read by the next maintenance pass. Every test moves
 * the manual clock; none waits on wall time.
 */
import {
  MAXIMUM_LOG_LINES_PER_RUN_LIMIT,
  workflow,
  type Engine,
  type WorkflowContext,
  type WorkflowLogLine,
  type WorkflowLogsResult,
} from '@lostgradient/weft';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog.ts';
import { createBureau } from './create-bureau.ts';
import { MAXIMUM_WORKFLOW_LOG_LINES_PER_RUN } from './settings/settings-schema.ts';
import { DAY_MS, withLiveSettingsBureau } from './testing/live-settings-bureau.test-support.ts';

const noop = async () => null;

/** A workflow that logs `count` lines before its single durable step and one after it. */
function loggingWorkflow(name: string, count: number) {
  return workflow({ name }).execute(async function* (ctx: WorkflowContext) {
    for (let index = 0; index < count; index++) ctx.log?.info(`line ${index}`, { index });
    yield* ctx.run(noop);
    ctx.log?.warn('after the step');
    return 'done';
  });
}

function linesOf(result: WorkflowLogsResult): WorkflowLogLine[] {
  return result.lines;
}

function engineOf(bureau: { durableEngine(): unknown }): Engine {
  return bureau.durableEngine() as Engine;
}

describe('BureauOptions.logs', () => {
  it('persists a workflow’s lines per run and per step, and still hands each to onLog', async () => {
    const heard: string[] = [];
    await withLiveSettingsBureau(
      async ({ bureau }) => {
        const engine = engineOf(bureau);
        engine.register(loggingWorkflow('logged-run', 2));
        const handle = await engine.start('logged-run', null, { id: 'run-a' });
        await handle.result();

        const all = await engine.getLogs('run-a');
        expect(all.dropped).toBe(0);
        expect(all.lines.map((line) => [line.step, line.level, line.message])).toEqual([
          [0, 'info', 'line 0'],
          [0, 'info', 'line 1'],
          [1, 'warn', 'after the step'],
        ]);
        expect(all.lines[0]?.attributes).toEqual({ index: 0 });
        const second = await engine.getLogs('run-a', { step: 1 });
        expect(second.lines.map((line) => line.message)).toEqual(['after the step']);
        expect(heard).toEqual(['line 0', 'line 1', 'after the step']);
      },
      { logs: {}, onLog: (record) => heard.push(record.message) },
    );
  });

  it('keeps no lines unless asked to', async () => {
    await withLiveSettingsBureau(
      async ({ bureau }) => {
        const engine = engineOf(bureau);
        engine.register(loggingWorkflow('unlogged-run', 1));
        const handle = await engine.start('unlogged-run', null, { id: 'run-b' });
        await handle.result();

        expect(await engine.getLogs('run-b')).toEqual({ lines: [], dropped: 0 });
      },
      { onLog: () => {} },
    );
  });

  it('caps a run at logs.maximumLinesPerRun, read on every line, and counts what it evicted', async () => {
    await withLiveSettingsBureau(
      async ({ bureau, change }) => {
        const engine = engineOf(bureau);
        engine.register(loggingWorkflow('capped-run', 3));
        const first = await engine.start('capped-run', null, { id: 'run-c1' });
        await first.result();
        expect(linesOf(await engine.getLogs('run-c1'))).toHaveLength(4);

        await change({ 'logs.maximumLinesPerRun': 2 });
        const second = await engine.start('capped-run', null, { id: 'run-c2' });
        await second.result();

        const capped = await engine.getLogs('run-c2');
        expect(capped.lines.map((line) => line.message)).toEqual(['line 2', 'after the step']);
        expect(capped.dropped).toBe(2);
      },
      { logs: { maximumLinesPerRun: 500 }, onLog: () => {} },
    );
  });

  it('prunes a run’s lines on the maintenance pass after retention.logs, and keeps them before it', async () => {
    await withLiveSettingsBureau(
      async ({ bureau, at, change }) => {
        const engine = engineOf(bureau);
        engine.register(loggingWorkflow('retained-run', 1));
        const handle = await engine.start('retained-run', null, { id: 'run-d' });
        await handle.result();
        await engine.getLogs('run-d');

        at(6 * DAY_MS);
        await bureau.maintain();
        expect(linesOf(await engine.getLogs('run-d'))).toHaveLength(2);

        at(8 * DAY_MS);
        await bureau.maintain();
        // The run is over: its lines go, and the count of what retention removed stays.
        expect(await engine.getLogs('run-d')).toEqual({ lines: [], dropped: 2 });

        // A shorter window set at runtime applies to the next pass.
        const later = await engine.start('retained-run', null, { id: 'run-e' });
        await later.result();
        await engine.getLogs('run-e');
        at(8 * DAY_MS + 61_000);
        await change({ 'retention.logs': { olderThan: 60_000 } });
        await bureau.maintain();
        expect(linesOf(await engine.getLogs('run-e'))).toEqual([]);
      },
      { logs: {}, retention: { logs: { olderThan: 7 * DAY_MS } }, onLog: () => {} },
    );
  });

  it('keeps the lines of a run that is still parked past retention.logs, and prunes them once it ends', async () => {
    await withLiveSettingsBureau(
      async ({ bureau, at }) => {
        const engine = engineOf(bureau);
        engine.register(
          workflow({ name: 'parked-run' }).execute(async function* (ctx: WorkflowContext) {
            ctx.log?.info('before the wait');
            const answer = yield* ctx.waitForSignal<string>('go');
            ctx.log?.info('after the wait');
            return answer;
          }),
        );
        const handle = await engine.start('parked-run', null, { id: 'run-parked' });
        await waitUntil(
          async () => {
            const logged = await engine.getLogs('run-parked');
            return logged.lines.length === 1;
          },
          {
            message: 'the run to log its line and park',
          },
        );

        at(8 * DAY_MS);
        await bureau.maintain();
        expect(linesOf(await engine.getLogs('run-parked')).map((line) => line.message)).toEqual([
          'before the wait',
        ]);

        await engine.signal('run-parked', 'go', 'done');
        await handle.result();
        expect(linesOf(await engine.getLogs('run-parked')).map((line) => line.message)).toEqual([
          'before the wait',
          'after the wait',
        ]);

        at(16 * DAY_MS);
        await bureau.maintain();
        expect(await engine.getLogs('run-parked')).toEqual({ lines: [], dropped: 2 });
      },
      { logs: {}, retention: { logs: { olderThan: 7 * DAY_MS } }, onLog: () => {} },
    );
  });

  it('keeps lines for good when no retention.logs window is set', async () => {
    await withLiveSettingsBureau(
      async ({ bureau, at }) => {
        const engine = engineOf(bureau);
        engine.register(loggingWorkflow('forever-run', 1));
        const handle = await engine.start('forever-run', null, { id: 'run-f' });
        await handle.result();
        await engine.getLogs('run-f');

        at(365 * DAY_MS);
        await bureau.maintain();
        expect(linesOf(await engine.getLogs('run-f'))).toHaveLength(2);
      },
      { logs: {}, onLog: () => {} },
    );
  });

  it('holds the settings cap equal to the cap Weft enforces', () => {
    expect(MAXIMUM_WORKFLOW_LOG_LINES_PER_RUN).toBe(MAXIMUM_LOG_LINES_PER_RUN_LIMIT);
  });

  it('refuses a cap or a window that is not a positive integer at construction', async () => {
    for (const logs of [
      { maximumLinesPerRun: 0 },
      { maximumLinesPerRun: 1.5 },
      { maximumLinesPerRun: 5001 },
    ]) {
      const failure = await createBureau<AgentDefinitions>({ agents: {}, logs }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
    }
    for (const olderThan of [0, -1, 1.5, '7d']) {
      const failure = await createBureau<AgentDefinitions>({
        agents: {},
        retention: { logs: { olderThan: olderThan as number } },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
    }
  });
});
