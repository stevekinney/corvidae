/**
 * COR-240 "Protocol and Outbox" — conformance-command coverage for the
 * protocol version bump (acceptance criterion 14: "Protocol schemas,
 * generated documentation, fixtures, and package exports agree on the new
 * protocol version").
 *
 * `cli-conformance.test.ts` already exercises `executeConformance()`'s full
 * check list end to end against the existing worker fixtures; those tests
 * are untouched and continue to pass because `startWorker()` always sets
 * `WEFT_WORKER_PROTOCOL_VERSION` from the live `REMOTE_WORKER_PROTOCOL_VERSION`
 * constant rather than a hardcoded literal. This file adds two things that
 * suite does not cover:
 *
 *   1. The conformance CLI's own JSON report surfaces the bumped protocol
 *      version and supported-version set, not a stale value.
 *   2. A worker that still speaks the retired protocol version 3 is
 *      rejected outright — proving there is no second compatibility parser
 *      for the retired version (the charter's explicit prohibition).
 */

import { describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Engine,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS,
  serve,
} from '../index.ts';
import {
  decodeRemoteTaskRecord,
  isRemoteTaskTerminalResolved,
  taskLedgerKey,
} from '../server/task-ledger.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { waitForCondition } from '../testing/fake-timers.test-support.ts';
import { executeConformance } from './index.ts';

/**
 * COR-233 "Transport and Conformance Integration" — the headline deliverable:
 * a fixture that deliberately loses the first `taskResultAck`, proving the
 * worker resends the exact same result and the server answers `duplicate` on
 * the second delivery, with the task resolving exactly once.
 *
 * This drives `conformance-lost-ack-worker.ts` directly against a minimal
 * `serve()` instance rather than through `executeConformance()`'s full
 * `runConformanceChecks()` sequence. That sequence's "reconnect" check spawns
 * a SECOND worker process from the same fixture command to replace the
 * first, and this fixture's "drop my first-ever ack" behavior is scoped per
 * OS process — the replacement would independently drop-and-resend its own
 * first result too, and both processes append to the same
 * `WEFT_LOST_ACK_STATE_FILE` without coordination, so the two would race on
 * a non-atomic read-modify-write JSON append and could lose entries. A
 * single worker, single dispatch, single resend keeps this deterministic.
 */
describe('conformance command — lost acknowledgement resend (COR-233)', () => {
  it('resends the byte-identical result after losing the first ack and resolves the task exactly once', async () => {
    const stateFile = join(tmpdir(), `weft-lost-ack-${crypto.randomUUID()}.json`);
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const server = serve({ engine, port: 0, hostname: '127.0.0.1' });
    const queue = 'lost-ack-conformance';
    const operationId = 'lost-ack-echo';

    const worker = Bun.spawn(['bun', './src/cli/__fixtures__/conformance-lost-ack-worker.ts'], {
      env: {
        ...Bun.env,
        WEFT_WORKER_URL: `${server.url.replace('http://', 'ws://')}/v1/tasks/${queue}/stream`,
        WEFT_WORKER_QUEUE: queue,
        WEFT_WORKER_ACTIVITIES: 'conformance.echo',
        WEFT_WORKER_PROTOCOL_VERSION: String(REMOTE_WORKER_PROTOCOL_VERSION),
        WEFT_LOST_ACK_STATE_FILE: stateFile,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    try {
      await waitForCondition(() => server.registry.getAll().length > 0, {
        timeoutMs: 3_000,
        intervalMs: 25,
        label: 'lost-ack worker register',
      });

      const dispatched = await server.dispatchTask({
        operationId,
        activityName: 'conformance.echo',
        workflowType: 'conformance',
        input: { ok: true },
        queue,
        visibilityTimeout: 3_000,
      });
      expect(dispatched).toBe(true);

      await waitForCondition(
        async () => {
          const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(operationId)));
          return isRemoteTaskTerminalResolved(record) && record.status === 'completed';
        },
        { timeoutMs: 3_000, intervalMs: 25, label: `${operationId} to resolve` },
      );
      const firstResolved = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(operationId)));
      if (!isRemoteTaskTerminalResolved(firstResolved)) {
        throw new Error(`Expected "${operationId}" to have a resolved terminal ledger record`);
      }

      // The worker records every ack's disposition it receives (dropped or
      // not) to the state file — wait for both the original delivery's
      // `applied` and the resend's `duplicate`.
      await waitForCondition(
        async () => {
          if (!(await Bun.file(stateFile).exists())) return false;
          const dispositions: unknown = JSON.parse(await Bun.file(stateFile).text());
          return Array.isArray(dispositions) && dispositions.length >= 2;
        },
        { timeoutMs: 3_000, intervalMs: 25, label: 'both ack dispositions recorded' },
      );

      const dispositions: unknown = JSON.parse(await Bun.file(stateFile).text());
      expect(dispositions).toEqual(['applied', 'duplicate']);

      // Resolved exactly once: the resend never produced a second terminal
      // write — the ledger record's generation is unchanged from the first
      // resolution.
      const afterResend = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(operationId)));
      expect(afterResend?.state).toBe('terminal');
      expect(afterResend?.generation).toBe(firstResolved.generation);
    } finally {
      worker.kill('SIGTERM');
      await Promise.race([worker.exited, Bun.sleep(500)]);
      if (worker.exitCode === null) {
        worker.kill('SIGKILL');
        await worker.exited.catch(() => undefined);
      }
      await server.stop();
      engine[Symbol.dispose]();
      rmSync(stateFile, { force: true });
    }
  });
});

describe('conformance command — protocol version (COR-240)', () => {
  it('reports the current protocol version and supported set in the JSON output', async () => {
    const result = await executeConformance({
      timeoutMs: 3_000,
      json: true,
      workerCommand: ['bun', './src/cli/__fixtures__/conformance-worker.ts'],
    });

    expect(result.exitCode).toBe(0);
    const report: { protocolVersion: number; supportedProtocolVersions: number[] } = JSON.parse(
      result.stdout,
    );
    expect(report.protocolVersion).toBe(REMOTE_WORKER_PROTOCOL_VERSION);
    expect(report.protocolVersion).toBe(4);
    expect(report.supportedProtocolVersions).toEqual([
      ...REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS,
    ]);
    expect(report.supportedProtocolVersions).toEqual([4]);
  });

  it('rejects a worker that still registers with the retired protocol version 3 — no dual compatibility parser', async () => {
    const result = await executeConformance({
      timeoutMs: 1_000,
      json: true,
      workerCommand: ['bun', './src/cli/__fixtures__/conformance-legacy-protocol-worker.ts'],
    });

    // Registration is rejected before it ever reaches the worker registry,
    // so the very first check ("register") times out waiting for a worker to
    // appear — the same failure shape an unrecognized future version would
    // produce, not a distinguishable "legacy version accepted" path.
    expect(result.exitCode).toBe(1);
    const report: {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; message: string }>;
    } = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ name: 'conformance', ok: false });
    expect(report.checks[0]?.message).toContain('Timed out');
    expect(report.checks[0]?.message).toContain('worker register');
  });
});
