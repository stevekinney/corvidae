/**
 * COR-1751 — the reader that reads the settings again on a notification: a notification that
 * arrives while a read is in flight is met only by a read that is known to be at least as new, so
 * the read in flight cannot consume it.
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { describe, expect, test } from 'bun:test';

import { SettingsReader, type SettingsReadOutcome } from './settings-reader.ts';

/** A read a test settles itself: `reads[n]` is the n-th read, and `settle` ends it. */
function controlledReads() {
  const reads: Array<(outcome: SettingsReadOutcome | undefined) => void> = [];
  return {
    reads,
    read: () =>
      new Promise<SettingsReadOutcome | undefined>((resolve) => {
        reads.push(resolve);
      }),
    /** Waits until the reader has asked for its `count`-th read. */
    async started(count: number) {
      await waitUntil(() => reads.length >= count, { message: `read ${count} to start` });
    },
  };
}

describe('SettingsReader', () => {
  test('reads again when a notification names a revision newer than the read it joined', async () => {
    const control = controlledReads();
    const reader = new SettingsReader({ read: control.read });

    // The first read was already in flight, so the reader joins it: it is not fresh.
    const done = reader.notify(4);
    await control.started(1);
    expect(control.reads).toHaveLength(1);
    control.reads[0]?.({ revision: 3, fresh: false });
    await control.started(2);
    expect(control.reads).toHaveLength(2);
    control.reads[1]?.({ revision: 4, fresh: true });
    await done;
    expect(control.reads).toHaveLength(2);
  });

  test('reads again when a notification arrives during a read that reports an older revision', async () => {
    const control = controlledReads();
    const reader = new SettingsReader({ read: control.read });

    const done = reader.notify(3);
    await control.started(1);
    void reader.notify(4);
    control.reads[0]?.({ revision: 3, fresh: true });
    await control.started(2);
    expect(control.reads).toHaveLength(2);
    control.reads[1]?.({ revision: 4, fresh: true });
    await done;
    expect(control.reads).toHaveLength(2);
  });

  test('does not read again when the read already reports the notified revision', async () => {
    const control = controlledReads();
    const reader = new SettingsReader({ read: control.read });

    const done = reader.notify(3);
    await control.started(1);
    void reader.notify(3);
    void reader.notify(2);
    control.reads[0]?.({ revision: 3, fresh: true });
    await done;
    expect(control.reads).toHaveLength(1);
  });

  test('does not read again for a revision a joined read already covers', async () => {
    const control = controlledReads();
    const reader = new SettingsReader({ read: control.read });

    const done = reader.notify(3);
    await control.started(1);
    control.reads[0]?.({ revision: 4, fresh: false });
    await done;
    expect(control.reads).toHaveLength(1);
  });

  test('reads again for a notification with no revision that arrives during a read, and only then', async () => {
    const control = controlledReads();
    const reader = new SettingsReader({ read: control.read });

    const done = reader.notify(3);
    await control.started(1);
    void reader.notify();
    control.reads[0]?.({ revision: 3, fresh: true });
    await control.started(2);
    expect(control.reads).toHaveLength(2);
    control.reads[1]?.({ revision: 3, fresh: true });
    await done;
    expect(control.reads).toHaveLength(2);
  });

  test('reads again for a notification with no revision that joined a read already in flight', async () => {
    const control = controlledReads();
    const reader = new SettingsReader({ read: control.read });

    const done = reader.notify();
    await control.started(1);
    control.reads[0]?.({ revision: 3, fresh: false });
    await control.started(2);
    expect(control.reads).toHaveLength(2);
    control.reads[1]?.({ revision: 3, fresh: true });
    await done;
    expect(control.reads).toHaveLength(2);
  });

  test('stops waiting when a read fails, and reads on the next notification', async () => {
    const control = controlledReads();
    const reader = new SettingsReader({ read: control.read });

    const done = reader.notify(4);
    await control.started(1);
    void reader.notify(5);
    control.reads[0]?.(undefined);
    await done;
    expect(control.reads).toHaveLength(1);

    const next = reader.notify(6);
    await control.started(2);
    expect(control.reads).toHaveLength(2);
    control.reads[1]?.({ revision: 6, fresh: true });
    await next;
  });
});
