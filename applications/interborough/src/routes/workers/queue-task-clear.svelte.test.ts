import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import CountHarness from './queue-task-clear-count.test-harness.svelte';

import { TaskClearController, type TaskClearDependencies } from './queue-task-clear.svelte.ts';

function harness(overrides: Partial<TaskClearDependencies> = {}) {
  const cleared: string[] = [];
  const toasts: { id: string; message: string; undo: () => void }[] = [];
  const dismissed: string[] = [];
  const refusals: (readonly unknown[])[] = [];
  let refreshed = 0;
  const controller = new TaskClearController({
    clear: async (operationId) => {
      cleared.push(operationId);
    },
    announce: (message, undo) => {
      const id = `toast-${String(toasts.length + 1)}`;
      toasts.push({ id, message, undo });
      return id;
    },
    dismiss: (id) => dismissed.push(id),
    refresh: async () => {
      refreshed += 1;
    },
    refused: (errors) => refusals.push(errors),
    ...overrides,
  });
  return { controller, cleared, toasts, dismissed, refusals, refreshed: () => refreshed };
}

describe('TaskClearController', () => {
  test('holds the tasks out of the lists and offers Undo, sending nothing yet', () => {
    const { controller, cleared, toasts } = harness();
    controller.stage('reports', ['a', 'b'], 'Cleared 2 failed tasks from the reports queue.');

    expect([...controller.hidden]).toEqual(['a', 'b']);
    expect(toasts.map((toast) => toast.message)).toEqual([
      'Cleared 2 failed tasks from the reports queue.',
    ]);
    expect(cleared).toEqual([]);
  });

  test('Undo puts the tasks back and nothing is ever sent for them', async () => {
    const { controller, cleared, toasts } = harness();
    controller.stage('reports', ['a', 'b'], 'Cleared.');
    toasts[0]?.undo();

    expect([...controller.hidden]).toEqual([]);
    await controller.flush();
    expect(cleared).toEqual([]);
  });

  test('leaving the page sends the clears, takes the toast down, and asks again for the lists', async () => {
    const { controller, cleared, dismissed, refreshed } = harness();
    controller.stage('reports', ['a', 'b'], 'Cleared.');
    await controller.flush();

    expect(cleared).toEqual(['a', 'b']);
    expect(dismissed).toEqual(['toast-1']);
    expect(refreshed()).toBe(1);
    expect([...controller.hidden]).toEqual([]);
  });

  test('keeps the tasks out of the lists until the lists have been read again', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller } = harness({ refresh: () => gate });
    controller.stage('reports', ['a'], 'Cleared.');
    const flushing = controller.flush();
    await Promise.resolve();
    expect([...controller.hidden]).toEqual(['a']);

    release();
    await flushing;
    expect([...controller.hidden]).toEqual([]);
  });

  test('a second Clear all commits the first, since there is one toast at a time', async () => {
    const { controller, cleared, dismissed, toasts } = harness();
    controller.stage('reports', ['a'], 'First.');
    controller.stage('reports', ['b'], 'Second.');
    await Promise.resolve();

    expect(dismissed).toEqual(['toast-1']);
    expect(toasts).toHaveLength(2);
    await controller.flush();
    expect(cleared.toSorted()).toEqual(['a', 'b']);
  });

  test('reports the clears the server refused and keeps going with the rest', async () => {
    const refusal = new Error('already cleared');
    const { controller, cleared, refusals } = harness({
      clear: async (operationId) => {
        if (operationId === 'a') throw refusal;
      },
    });
    controller.stage('reports', ['a', 'b'], 'Cleared.');
    await controller.flush();

    expect(refusals).toEqual([[refusal]]);
    expect(cleared).toEqual([]);
    expect([...controller.hidden]).toEqual([]);
  });

  test('counts the tasks held out of a queue, and none once they are undone or sent', async () => {
    const { controller, toasts } = harness();
    controller.stage('reports', ['a', 'b'], 'Cleared.');
    expect(controller.hiddenCount('reports')).toBe(2);
    expect(controller.hiddenCount('payments')).toBe(0);

    toasts[0]?.undo();
    expect(controller.hiddenCount('reports')).toBe(0);

    controller.stage('reports', ['c'], 'Cleared.');
    await controller.flush();
    expect(controller.hiddenCount('reports')).toBe(0);
  });

  test('a count derived from the held tasks follows a clear and its Undo (row 78u)', async () => {
    const { controller, toasts } = harness();
    const view = render(CountHarness, { controller, queue: 'reports' });
    expect(view.getByTestId('held').textContent).toBe('0');

    controller.stage('reports', ['a', 'b'], 'Cleared.');
    await tick();
    expect(view.getByTestId('held').textContent).toBe('2');

    toasts[0]?.undo();
    await tick();
    expect(view.getByTestId('held').textContent).toBe('0');
  });

  test('stages nothing for no tasks', () => {
    const { controller, toasts } = harness();
    controller.stage('reports', [], 'Cleared.');
    expect(toasts).toEqual([]);
  });

  test('flushing twice sends each clear once', async () => {
    const { controller, cleared } = harness();
    controller.stage('reports', ['a'], 'Cleared.');
    await Promise.all([controller.flush(), controller.flush()]);
    expect(cleared).toEqual(['a']);
  });
});
