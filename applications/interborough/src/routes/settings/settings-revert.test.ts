/**
 * Revert and its Undo (board SettingsShell, "More states"), apart from the page: what each writes,
 * what a stale revision and a refusal do, and that leaving the page removes the Undo toast.
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import { SETTINGS_COPY } from '../../app/copy.ts';
import type { SettingsSnapshot } from '../../lib/bureau-settings.ts';
import type { SettingsForm } from './settings-form.svelte.ts';
import { SettingsRevert } from './settings-revert.svelte.ts';

const KEY = 'engine.maxConcurrentRuns';

function snapshotAt(revision: number, values: Record<string, unknown>): SettingsSnapshot {
  return {
    values,
    effective: values,
    running: { [KEY]: 4 },
    revision,
    persisted: true,
    keys: { [KEY]: { apply: 'restart', locked: false, pendingRestart: values[KEY] !== 4 } },
  };
}

function stale(currentRevision: number): HttpClientError {
  return new HttpClientError(409, 'stale', {
    data: { weftCode: 'StaleRevision', currentRevision },
  });
}

function harness(answers: Array<() => unknown>) {
  const form = { revision: 1, rebase: (next: SettingsSnapshot) => (form.revision = next.revision) };
  const sent: Array<{ patch: Record<string, unknown>; revision: number }> = [];
  const toasts: Array<{ message: string; undo: () => void }> = [];
  const dismissed: string[] = [];
  const failures: string[] = [];
  let current = snapshotAt(1, { [KEY]: 6 });
  const revert = new SettingsRevert({
    form: form as unknown as SettingsForm,
    update: (patch, revision) => {
      sent.push({ patch, revision });
      const answer = answers.shift();
      const result = answer?.();
      current = snapshotAt(current.revision + 1, { ...current.values, ...patch });
      return Promise.resolve(result as { revision: number; pendingRestart: string[] });
    },
    read: () => Promise.resolve(current),
    showUndo: (message, undo) => {
      toasts.push({ message, undo });
      return `toast-${String(toasts.length)}`;
    },
    dismiss: (id) => dismissed.push(id),
    fail: (message) => failures.push(message),
  });
  return { revert, sent, toasts, dismissed, failures, snapshot: () => current };
}

describe('Revert', () => {
  test('writes the running value, marks the row reverted, and Undo writes the saved one back', async () => {
    const { revert, sent, toasts, snapshot } = harness([]);
    await revert.revert([KEY], snapshot());
    expect(sent).toEqual([{ patch: { [KEY]: 4 }, revision: 1 }]);
    expect(revert.isReverted(KEY)).toBe(true);
    expect(toasts.map((toast) => toast.message)).toEqual([SETTINGS_COPY.general.reverted.toast(1)]);

    toasts[0]?.undo();
    await waitUntil(() => !revert.isReverted(KEY), { message: 'Undo to be written' });
    expect(sent.at(-1)).toEqual({ patch: { [KEY]: 6 }, revision: 2 });
  });

  test('reads again and goes once more when the revision was stale', async () => {
    const { revert, sent, failures, snapshot } = harness([
      () => {
        throw stale(2);
      },
    ]);
    await revert.revert([KEY], snapshot());
    expect(sent).toHaveLength(2);
    expect(failures).toEqual([]);
    expect(revert.isReverted(KEY)).toBe(true);
  });

  test('says so, and marks nothing, when the Bureau refuses it', async () => {
    const refused = new HttpClientError(422, 'locked', {
      data: { weftCode: 'Unprocessable', reason: 'locked' },
    });
    const { revert, failures, toasts, snapshot } = harness([
      () => {
        throw refused;
      },
    ]);
    await revert.revert([KEY], snapshot());
    expect(failures).toEqual([SETTINGS_COPY.general.reverted.revertFailed]);
    expect(toasts).toEqual([]);
    expect(revert.isReverted(KEY)).toBe(false);
    expect(revert.busy).toBe(false);
  });

  test('a row changed again is no longer reverted, and leaving the page removes the Undo toast', async () => {
    const { revert, dismissed, snapshot } = harness([]);
    await revert.revert([KEY], snapshot());
    revert.forget(KEY);
    expect(revert.isReverted(KEY)).toBe(false);
    revert.dispose();
    expect(dismissed).toEqual(['toast-1']);
  });
});
