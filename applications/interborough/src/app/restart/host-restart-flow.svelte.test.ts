/**
 * The shell's restart flow (`shell:restart-flow`): the command is read while the host answers, the
 * attempts back off 1, 2, 4 and 8 seconds and stop after 8, Retry now probes at once, and Keep
 * waiting watches again. The host is a stand-in (`plugins-host.test-support.ts`); the real routes
 * are exercised by `src/host/host-plugins.test.ts`.
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { BureauStub } from '../../lib/bureau-stub.test-support.ts';
import {
  installFakePluginHost,
  type FakePluginHost,
} from '../../routes/settings/plugins/plugins-host.test-support.ts';
import { RestartFlow } from '../../routes/settings/plugins/restart-flow.svelte.ts';
import {
  installSettingsBureau,
  servedSettings,
} from '../../routes/settings/settings-fixtures.test-support.ts';
import { restartActivity, restartProbing } from './host-restart-flow.svelte.ts';

let host: FakePluginHost | undefined;
let bureau: BureauStub | undefined;
let flow: RestartFlow | undefined;
const probing = { ...restartProbing };

beforeEach(() => {
  restartProbing.delayMs = 0;
  restartProbing.retryDelayMs = () => 0;
});

afterEach(() => {
  flow?.dispose();
  flow = undefined;
  // Newest first: each stand-in restores the fetch it found.
  host?.restore();
  host = undefined;
  bureau?.restore();
  bureau = undefined;
  Object.assign(restartProbing, probing);
});

function start(options: Parameters<typeof installFakePluginHost>[1] = {}) {
  // The watch reads the settings too, so the Bureau answers them; no setting waits for a restart.
  bureau = installSettingsBureau(servedSettings());
  host = installFakePluginHost([{ name: 'demo', enabled: false }], options);
  flow = new RestartFlow();
  return flow;
}

describe('HostRestartFlow', () => {
  test('reads how the host was launched before it asks the host to restart', async () => {
    const restart = start();
    await restart.run([{ name: 'demo', enabled: true }], false, { changes: ['demo'] });

    const order = (host?.requests ?? []).map((r) => `${r.method} ${r.path}`);
    expect(order.indexOf('GET /host/restart')).toBeGreaterThan(-1);
    expect(order.indexOf('GET /host/restart')).toBeLessThan(order.indexOf('POST /host/restart'));
    expect(restart.launchCommand).toBe('bun run start');
    expect(restart.phase).toBe('back');
  });

  test('keeps the shell quiet while the restart shows, and lets go when it ends', async () => {
    const restart = start({ downFor: 3 });
    const done = restart.run([{ name: 'demo', enabled: true }], false, { changes: ['demo'] });
    expect(restartActivity.active).toBe(true);
    await done;
    expect(restart.phase).toBe('back');
    // The dialog is gone once the host is back, so the shell may speak again.
    expect(restartActivity.active).toBe(false);
  });

  test('is failed after 8 attempts that follow the read that found the host down', async () => {
    const seen: number[] = [];
    restartProbing.retryDelayMs = (attempt) => {
      seen.push(attempt);
      return 0;
    };
    const restart = start({ downFor: 1_000 });
    await restart.run([{ name: 'demo', enabled: true }], false, { changes: ['demo'] });

    expect(restart.phase).toBe('failed');
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(restart.attempt).toBe(8);
    expect(restart.lastError).toBe('Failed to fetch');
    // The dialog stays up, because the host never answered.
    expect(restart.open).toBe(true);
    expect(restartActivity.active).toBe(true);
  });

  test('waits 1, 2, 4 and then 8 seconds between attempts, like the app-wide banner', () => {
    expect([1, 2, 3, 4, 5, 8].map((attempt) => probing.retryDelayMs(attempt))).toEqual([
      1_000, 2_000, 4_000, 8_000, 8_000, 8_000,
    ]);
  });

  test('Keep waiting watches again from the first attempt, and the host coming back ends it', async () => {
    const restart = start({ downFor: 12 });
    await restart.run([{ name: 'demo', enabled: true }], false, { changes: ['demo'] });
    expect(restart.phase).toBe('failed');

    restart.keepWaiting();
    expect(restart.phase).toBe('starting');
    expect(restart.attempt).toBe(0);
    await waitUntil(() => restart.phase === 'back');
    expect(restartActivity.active).toBe(false);
  });

  test('Retry now probes at once instead of waiting out the countdown, and counts from the first attempt', async () => {
    restartProbing.retryDelayMs = () => 3_600_000;
    const restart = start({ downFor: 1 });
    const done = restart.run([{ name: 'demo', enabled: true }], false, { changes: ['demo'] });
    await waitUntil(() => restart.phase === 'starting');
    expect(restart.attempt).toBe(1);
    expect(restart.retryInSeconds).toBe(3_600);

    restart.retryNow();
    await done;
    expect(restart.phase).toBe('back');
  });

  test('has nothing to retry or keep waiting for while the host answers', async () => {
    const restart = start();
    restart.retryNow();
    restart.keepWaiting();
    expect(restart.phase).toBe('idle');
  });

  test('leaves the command unknown when the host cannot say how it was launched', async () => {
    const restart = start();
    host!.launch = null;
    await restart.run([{ name: 'demo', enabled: true }], false, { changes: ['demo'] });
    expect(restart.launchCommand).toBeUndefined();
  });
});
