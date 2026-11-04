/**
 * COR-2009 — the offset clock, and a host run on it through `HostOptions.runtime`: the host's own
 * records, its Bureau's and its engine's are written at the clock's time.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';
import { createOffsetRuntime } from './offset-runtime.ts';
import { showcaseBuiltInAgents } from './showcase-agents.ts';

/** 9:00 AM CST on Monday, Nov 2, 2026: the instant the showcase host boots at. */
const NINE_AM = Date.parse('2026-11-02T09:00:00-06:00');
/** Long enough for a host to start on a slow machine, short against a day. */
const ONE_HOUR = 3_600_000;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

describe('createOffsetRuntime', () => {
  test('reads the instant it was set to, then runs on in real time', () => {
    const runtime = createOffsetRuntime(NINE_AM);
    const first = runtime.clock.now();
    expect(first).toBeGreaterThanOrEqual(NINE_AM);
    expect(first - NINE_AM).toBeLessThan(ONE_HOUR);
    expect(Date.parse(runtime.clock.nowISO())).toBeGreaterThanOrEqual(first);

    runtime.advance(46 * 60_000);
    expect(runtime.clock.now() - NINE_AM).toBeGreaterThanOrEqual(46 * 60_000);

    const october = Date.parse('2026-10-23T08:00:00-05:00');
    runtime.setTime(october);
    expect(runtime.clock.now()).toBeGreaterThanOrEqual(october);
    expect(runtime.clock.now() - october).toBeLessThan(ONE_HOUR);
  });

  test('never moves backwards by advancing', () => {
    const runtime = createOffsetRuntime(NINE_AM);
    expect(() => runtime.advance(-1)).toThrow(RangeError);
    expect(() => runtime.advance(Number.NaN)).toThrow(RangeError);
  });
});

describe('a host on an offset clock', () => {
  test('records its start, and its engine schedules, at the clock’s time', async () => {
    const home = await mkdtemp(join(tmpdir(), 'interborough-offset-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const host: Host = await startHost({
      environment: { INTERBOROUGH_HOME: home },
      port: 0,
      runtime: createOffsetRuntime(NINE_AM),
      extraAgents: showcaseBuiltInAgents(),
    });
    cleanups.push(() => host.close());

    const page = await host.bureau.audit.query({ limit: 100 });
    const started = page.records.find((record) => record.type === 'host.started');
    const startedAt = Date.parse(started?.timestamp ?? '');
    expect(startedAt).toBeGreaterThanOrEqual(NINE_AM);
    expect(startedAt - NINE_AM).toBeLessThan(ONE_HOUR);

    // An agent schedule's next fire is reckoned on the engine's clock: 3:00 AM tomorrow, Nov 3.
    const schedule = await host.bureau.schedules.create({
      agentName: 'assistant',
      input: 'Summarize yesterday.',
      spec: '0 3 * * *',
      timeZone: 'America/Chicago',
    });
    expect(schedule?.nextFireAt).toBe(Date.parse('2026-11-03T03:00:00-06:00'));
  });
});
