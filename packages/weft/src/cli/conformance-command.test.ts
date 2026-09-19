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

import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS,
} from '../index.ts';
import { executeConformance } from './index.ts';

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
