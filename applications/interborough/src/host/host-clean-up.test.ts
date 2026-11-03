/**
 * COR-2009 — Settings › Data and retention's "Remove expired records" row: `GET /host/clean-up`
 * says the host cleans up every night at 3:00 AM in its time zone, when it last did and that it
 * skipped a night it was off for, and "Clean up now" (`POST /host/clean-up`) reports on its own
 * row how many records it removed. Both go through the request guard.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Fetcher } from '../lib/bureau-client.ts';
import { cleanUpNow, getCleanUpStanding } from '../lib/host-clean-up.ts';
import { startHost, type Host } from './host.ts';
import { HOST_CLEAN_UP_ROUTE } from './nightly-clean-up.ts';

const DAY = 24 * 60 * 60 * 1000;
const CENTRAL = 'America/Chicago';
/** Mon Nov 2, 2026, 10:46 AM Central: the sample world's now. */
const SAMPLE_NOW = Date.parse('2026-11-02T16:46:00.000Z');

const homes: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function start(now: () => number = () => SAMPLE_NOW): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-clean-up-'));
  homes.push(home);
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    nightlyCleanUp: { timeZone: CENTRAL, now },
  });
  hosts.push(host);
  return host;
}

/** A fetch against the host's origin, as the page's relative requests are. */
const fetchFrom =
  (host: Host): Fetcher =>
  (input, init) =>
    fetch(new URL(input instanceof Request ? input.url : input, host.url), init);

describe('the host’s nightly clean-up', () => {
  test('runs every night at 3:00 AM Central, and has nothing to report before the first', async () => {
    const host = await start();

    expect(await getCleanUpStanding({ fetch: fetchFrom(host) })).toEqual({
      schedule: { hour: 3, minute: 0, timeZone: CENTRAL },
      last: null,
      skipped: null,
      nextAt: '2026-11-03T09:00:00.000Z',
    });
  });

  test('Clean up now removes the expired records and reports how many on its row', async () => {
    const host = await start();
    const trail = host.bureau.internals.auditTrail!;
    const now = Date.now();
    // A schedule is no run the fleet feed retains, so only the 90-day window decides.
    await trail.record({
      runId: 'schedule:old',
      type: 'schedule.note',
      detail: {},
      timestampMs: now - 91 * DAY,
    });

    const run = await cleanUpNow({ fetch: fetchFrom(host) });

    expect(run).toMatchObject({ trigger: 'manual', at: new Date(SAMPLE_NOW).toISOString() });
    expect(run.byKind.audit).toBe(1);
    expect(run.removed).toBe(run.byKind.audit);
    expect(run.failed).toEqual([]);
    expect(await getCleanUpStanding({ fetch: fetchFrom(host) })).toMatchObject({
      last: run,
      skipped: null,
    });
  });

  test('says it skipped today when the host was off at 3:00 AM', async () => {
    // Cleaned up on Sun Nov 1 at 3:00 AM, then off until 9:00 AM Mon Nov 2.
    let clock = Date.parse('2026-11-01T09:00:00.000Z');
    const first = await start(() => clock);
    await first.cleanUp.cleanUpNow();
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);

    clock = Date.parse('2026-11-02T15:00:00.000Z');
    const home = homes[0]!;
    const second = await startHost({
      environment: { INTERBOROUGH_HOME: home },
      port: 0,
      nightlyCleanUp: { timeZone: CENTRAL, now: () => clock },
    });
    hosts.push(second);
    clock = SAMPLE_NOW;

    expect(await second.cleanUp.standing()).toMatchObject({
      last: { at: '2026-11-01T09:00:00.000Z' },
      skipped: { at: '2026-11-02T09:00:00.000Z' },
    });
  });

  test('refuses a request from another origin', async () => {
    const host = await start();
    const response = await fetch(new URL(HOST_CLEAN_UP_ROUTE, host.url), {
      method: 'POST',
      headers: { origin: 'https://example.com' },
    });

    expect(response.status).toBe(403);
  });
});
