/**
 * `POST /host/restart` asks the host to restart through the entry's callback. It goes through the
 * request guard like every route, answers before the callback runs, and calls it once.
 */
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host, type HostOptions } from './host.ts';
import { HOST_RESTART_ROUTE } from './restart.ts';

const homes: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function start(options: Pick<HostOptions, 'onRestartRequested'> = {}): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-restart-'));
  homes.push(home);
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    ...options,
  });
  hosts.push(host);
  return host;
}

const restartUrl = (host: Host): URL => new URL(HOST_RESTART_ROUTE, host.url);

describe('POST /host/restart', () => {
  test('answers 202 and then calls the restart callback', async () => {
    let calls = 0;
    const host = await start({ onRestartRequested: () => void (calls += 1) });
    const response = await fetch(restartUrl(host), { method: 'POST' });
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 202,
      body: { restarting: true },
    });
    await waitUntil(() => calls === 1, { message: 'the restart callback to run' });
  });

  test('accepts the listener’s own origin', async () => {
    let calls = 0;
    const host = await start({ onRestartRequested: () => void (calls += 1) });
    const response = await fetch(restartUrl(host), {
      method: 'POST',
      headers: { origin: host.url.origin },
    });
    expect(response.status).toBe(202);
    await waitUntil(() => calls === 1, { message: 'the restart callback to run' });
  });

  test('refuses a cross-origin request, and does not restart', async () => {
    let calls = 0;
    const host = await start({ onRestartRequested: () => void (calls += 1) });
    const response = await fetch(restartUrl(host), {
      method: 'POST',
      headers: { origin: 'https://attacker.example' },
    });
    expect(response.status).toBe(403);
    await quietFor(250);
    expect(calls).toBe(0);
  });

  test('refuses a rebound Host, and does not restart', async () => {
    let calls = 0;
    const host = await start({ onRestartRequested: () => void (calls += 1) });
    const response = await fetch(restartUrl(host), {
      method: 'POST',
      headers: { host: 'attacker.example' },
    });
    expect(response.status).toBe(403);
    await quietFor(250);
    expect(calls).toBe(0);
  });

  test('calls the callback once, however many requests arrive while it runs', async () => {
    let calls = 0;
    const host = await start({ onRestartRequested: () => void (calls += 1) });
    const responses = await Promise.all(
      [1, 2, 3].map(() => fetch(restartUrl(host), { method: 'POST' })),
    );
    expect(responses.map((response) => response.status)).toEqual([202, 202, 202]);
    await waitUntil(() => calls >= 1, { message: 'the restart callback to run' });
    await quietFor(250);
    expect(calls).toBe(1);
  });

  test('reports a callback that fails and lets the next request try again', async () => {
    const report = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let calls = 0;
      const host = await start({
        onRestartRequested: () => {
          calls += 1;
          if (calls === 1) throw new Error('the first attempt failed');
        },
      });
      await fetch(restartUrl(host), { method: 'POST' });
      await waitUntil(() => report.mock.calls.length === 1, {
        message: 'the failure to be reported',
      });
      await fetch(restartUrl(host), { method: 'POST' });
      await waitUntil(() => calls === 2, { message: 'the second attempt' });
      expect(report.mock.calls[0]?.[0]).toBe('The restart failed.');
    } finally {
      report.mockRestore();
    }
  });

  test('is not a route on a host started without a restart callback', async () => {
    const host = await start();
    const response = await fetch(restartUrl(host), { method: 'POST' });
    expect(response.status).toBe(404);
  });
});
