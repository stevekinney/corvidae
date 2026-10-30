/**
 * COR-1810 — the host keeps its audit trail 90 days by default: the Bureau starts with a
 * `retention.audit` window of 90 days, the maintenance sweep prunes older records and keeps newer
 * ones, and a stored setting replaces the default.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AUDIT_RETENTION_MILLISECONDS, startHost, type Host } from './host.ts';

const DAY = 24 * 60 * 60 * 1000;
const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function start() {
  const home = await mkdtemp(join(tmpdir(), 'interborough-audit-retention-'));
  directories.push(home);
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0, seed: false });
  hosts.push(host);
  return host;
}

describe('the host’s audit retention', () => {
  test('defaults to 90 days, and the Settings page can replace it', async () => {
    const host = await start();

    const snapshot = await host.bureau.settings.get();
    expect(AUDIT_RETENTION_MILLISECONDS).toBe(90 * DAY);
    expect(snapshot.values['retention.audit']).toEqual({ olderThan: 90 * DAY });

    const updated = await host.bureau.settings.update(
      { 'retention.audit': { olderThan: 30 * DAY } },
      { expectedRevision: snapshot.revision },
    );
    expect(updated.outcome).toBe('applied');
    const after = await host.bureau.settings.get();
    expect(after.values['retention.audit']).toEqual({
      olderThan: 30 * DAY,
    });
  });

  test('the maintenance sweep prunes audit records older than 90 days and keeps newer ones', async () => {
    const host = await start();
    const trail = host.bureau.internals.auditTrail!;
    const now = Date.now();
    // A schedule is no run the fleet feed retains, so only the window decides.
    await trail.record({
      runId: 'schedule:old',
      type: 'schedule.note',
      detail: { status: 'old' },
      timestampMs: now - 91 * DAY,
    });
    await trail.record({
      runId: 'schedule:recent',
      type: 'schedule.note',
      detail: { status: 'recent' },
      timestampMs: now - 89 * DAY,
    });

    await host.bureau.maintain();

    const remaining = await trail.query({ type: 'schedule.note' });
    expect(remaining.map((record) => record.runId)).toEqual(['schedule:recent']);
  });
});
