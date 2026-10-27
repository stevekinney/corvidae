/**
 * COR-1751 — the follower of `bureau.settings.events`: it tells the page on open and on each
 * change, resumes from the last revision it was given, and stops for a refusal retrying cannot
 * change.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { SettingsFollower } from './settings-follower.ts';

const followers: SettingsFollower[] = [];
afterEach(() => {
  for (const follower of followers.splice(0)) follower.dispose();
});

function frame(revision: number, keys: string[]): string {
  const data = {
    kind: 'settings.changed',
    cursor: String(revision),
    emittedAtMs: 1,
    revision,
    keys,
  };
  return `id: ${revision}\nevent: settings.changed\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Waits for `condition` by yielding to the event loop, with no deadline of its own. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SettingsFollower', () => {
  test('tells the page on open and after each change, and resumes from the last cursor', async () => {
    const lastEventIds: Array<string | null> = [];
    const bodies = [frame(2, ['tools.wakeup']) + frame(3, ['tools.decide']), ''];
    let told = 0;
    const waits: number[] = [];
    const follower = new SettingsFollower({
      onChange: () => {
        told += 1;
      },
      fetch: (_input, init) => {
        lastEventIds.push(new Headers(init?.headers).get('last-event-id'));
        return Promise.resolve(new Response(bodies.shift() ?? ''));
      },
      // The first backoff passes; the next one waits until the follower is disposed.
      sleep: (milliseconds, signal) => {
        waits.push(milliseconds);
        if (waits.length === 1) return Promise.resolve();
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve()));
      },
    });
    followers.push(follower);
    follower.start();

    await until(() => lastEventIds.length >= 2);
    expect(lastEventIds.slice(0, 2)).toEqual([null, '3']);
    // One call for each accepted subscription, and one for each of the two changes.
    await until(() => told >= 4);
    expect(waits[0]).toBe(1_000);
  });

  test('stops for a refusal that retrying cannot change', async () => {
    let opened = 0;
    const follower = new SettingsFollower({
      onChange: () => undefined,
      fetch: () => {
        opened += 1;
        return Promise.resolve(Response.json({ error: 'Forbidden' }, { status: 403 }));
      },
      sleep: () => Promise.resolve(),
    });
    followers.push(follower);
    follower.start();

    await until(() => opened >= 1);
    // Give a retry the chance to happen; none is waiting.
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opened).toBe(1);
  });
});
