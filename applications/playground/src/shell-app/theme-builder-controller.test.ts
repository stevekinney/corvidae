import { describe, expect, test } from 'bun:test';

import { awakeTurns } from '@lostgradient/testing/wait-until';
import { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import { bus, evaluator, tab } from './theme-builder-test-support.ts';
import type { ThemeEvaluator } from './theme-draft-evaluation.ts';
import { THEME_RECORD_VERSION } from './theme-draft-record.ts';
import { domError, memoryThemeStore } from './theme-draft-test-support.ts';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

const px = (value: number) => ({ $type: 'dimension', $value: { value, unit: 'px' } });
const setRadius = (value: number, scope: 'shared' | 'dark' = 'shared') => ({
  kind: 'edit' as const,
  label: 'Edit radius',
  edit: { kind: 'set-override' as const, scope, path: 'radius.medium', node: px(value) },
});

describe('starting', () => {
  test('creates a default theme, saves it, and a second start restores it', async () => {
    const store = memoryThemeStore();
    const first = tab(store);
    await first.controller.start();
    await first.controller.flush();
    expect(first.controller.active?.draft.envelope.name).toBe('Cinder default');
    expect(first.workbench.saveStatus).toBe('saved');

    await first.controller.commit(setRadius(3));
    await first.controller.flush();

    const second = tab(store);
    await second.controller.start();
    expect(second.controller.active?.draft.envelope.overrides.shared).toEqual({
      radius: { medium: px(3) },
    });
    expect(second.controller.draftValues.get('--cinder-radius-md')).toBe('3px');
    expect(second.workbench.saveStatus).toBe('saved');
  });

  test('storage that refuses keeps the draft in memory and offers a download', async () => {
    const store = memoryThemeStore();
    store.failAlways = domError('SecurityError');
    const { controller, workbench } = tab(store);
    await controller.start();
    await controller.commit(setRadius(5));
    await controller.flush();
    expect(controller.active?.draft.envelope.overrides.shared).toEqual({
      radius: { medium: px(5) },
    });
    expect(workbench.saveStatus).toBe('unsaved');
    expect(workbench.storageNotice?.actions).toContain('download');
  });
});

describe('a record from a newer version', () => {
  const futureRecord = {
    recordVersion: THEME_RECORD_VERSION + 1,
    id: 'future',
    name: 'From the future',
    payload: { unknown: true },
  };

  test('can be deleted permanently only after this tab downloaded it', async () => {
    const store = memoryThemeStore();
    store.seed('themes', 'future', futureRecord);
    const { controller } = tab(store);
    await controller.start();
    const problem = controller.problems.find((candidate) => candidate.id === 'future');
    if (problem === undefined) throw new Error('the future-version record was not reported');
    expect(problem.kind).toBe('future-version');
    expect(controller.canDeleteProblem(problem)).toBe(false);

    const early = await controller.deleteFutureVersionProblem(problem);
    expect(early.ok).toBe(false);
    expect(store.data.themes.get('future')).toEqual(futureRecord);

    controller.downloadProblem(problem);
    expect(controller.canDeleteProblem(problem)).toBe(true);
    const removal = await controller.deleteFutureVersionProblem(problem);
    expect(removal.ok).toBe(true);
    expect(store.data.themes.has('future')).toBe(false);
    expect(controller.problems.some((candidate) => candidate.id === 'future')).toBe(false);
  });
});

describe('committing', () => {
  test('one edit is one history transaction, one revision, and one preview map', async () => {
    const { controller, workbench } = tab(memoryThemeStore());
    await controller.start();
    const before = controller.draft!.revision;
    const revision = workbench.revision;
    const outcome = await controller.commit(setRadius(4));
    expect(outcome).toEqual({ ok: true, changed: true });
    expect(controller.draft!.revision).toBe(before + 1);
    expect(controller.history!.entries).toHaveLength(1);
    expect(workbench.properties).toEqual([{ name: '--cinder-radius-md', value: '4px' }]);
    expect(workbench.revision).toBe(revision + 1);
  });

  test('a value the runtime rejects changes nothing and reports its path', async () => {
    const { controller, workbench } = tab(memoryThemeStore());
    await controller.start();
    await controller.commit(setRadius(4));
    const snapshot = controller.draft;
    const outcome = await controller.commit({
      kind: 'edit',
      label: 'bad',
      edit: {
        kind: 'set-override',
        scope: 'shared',
        path: 'radius.medium',
        node: { $type: 'dimension', $value: { value: 1, unit: 'furlong' } },
      },
    });
    expect(outcome).toMatchObject({ ok: false, path: 'radius.medium' });
    expect(controller.draft).toBe(snapshot);
    expect(controller.history!.entries).toHaveLength(1);
    expect(workbench.properties).toEqual([{ name: '--cinder-radius-md', value: '4px' }]);
    expect(controller.rejection?.path).toBe('radius.medium');
  });

  test('partial input stays in the buffer and marks the preview as the last valid revision', async () => {
    const { controller, workbench } = tab(memoryThemeStore());
    await controller.start();
    controller.setInputBuffer('radius.medium@source', { text: '{"val', error: 'Not valid JSON.' });
    expect(workbench.previewIsLastValid).toBe(true);
    expect(controller.draft!.inputBuffer['radius.medium@source']?.text).toBe('{"val');
    expect(controller.draft!.revision).toBe(1);
    controller.clearInputBuffer('radius.medium@source');
    expect(workbench.previewIsLastValid).toBe(false);
  });
});

describe('history and reset', () => {
  test('undo and redo restore the state and the preview, one step each', async () => {
    const { controller, workbench } = tab(memoryThemeStore());
    await controller.start();
    await controller.commit(setRadius(4));
    await controller.commit(setRadius(6));
    await controller.undo();
    expect(workbench.properties[0]?.value).toBe('4px');
    expect(controller.canRedo).toBe(true);
    await controller.undo();
    expect(workbench.properties[0]?.value).toBe('0.5rem');
    expect(controller.canUndo).toBe(false);
    await controller.redo();
    await controller.redo();
    expect(workbench.properties[0]?.value).toBe('6px');
    expect(controller.history!.entries).toHaveLength(2);
  });

  test('reset at field, color mode, and theme scope are one transaction each and undoable', async () => {
    const { controller } = tab(memoryThemeStore());
    await controller.start();
    await controller.commit(setRadius(4));
    await controller.commit(setRadius(7, 'dark'));
    await controller.reset({ kind: 'color-mode', colorMode: 'dark' }, 'Reset dark mode');
    expect(controller.draft!.envelope.overrides.dark).toEqual({});
    expect(controller.draft!.envelope.overrides.shared).toEqual({ radius: { medium: px(4) } });
    await controller.reset({ kind: 'field', path: 'radius.medium' }, 'Reset radius.medium');
    expect(controller.changedPaths.size).toBe(0);
    expect(controller.history!.entries).toHaveLength(4);
    await controller.undo();
    expect(controller.draft!.envelope.overrides.shared).toEqual({ radius: { medium: px(4) } });
    await controller.reset({ kind: 'theme' }, 'Reset theme');
    expect(controller.history!.entries.at(-1)?.kind).toBe('reset');
  });

  test('switching context renders that context’s map and adds no history', async () => {
    const { controller, workbench } = tab(memoryThemeStore());
    await controller.start();
    await controller.commit(setRadius(4));
    await controller.commit(setRadius(9, 'dark'));
    const entries = controller.history!.entries.length;
    workbench.setContext({ colorMode: 'dark', motion: 'default' });
    await controller.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(workbench.properties[0]?.value).toBe('9px');
    expect(workbench.context.colorMode).toBe('dark');
    expect(controller.history!.entries).toHaveLength(entries);
  });
});

describe('context changes made before the previous one has landed', () => {
  // The runtime evaluates in a worker, so a context change lands a moment after it is made.
  // A second change made in that moment must build on the first, not on the applied context.
  test('two quick changes land as one combined context', async () => {
    const workbench = new ThemeWorkbenchState();
    const slow: ThemeEvaluator = {
      async evaluate(source, revision, context) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return evaluator.evaluate(source, revision, context);
      },
    };
    const controller = new ThemeBuilderController({
      workbench,
      evaluator: slow,
      persistence: null,
      newId: () => 'theme-quick',
      now: () => '2026-10-14T00:00:00.000Z',
    });
    await controller.start();

    workbench.setContext({ ...workbench.requestedContext, colorMode: 'dark' });
    workbench.setContext({ ...workbench.requestedContext, motion: 'reduced' });
    expect(workbench.requestedContext).toEqual({ colorMode: 'dark', motion: 'reduced' });
    for await (const attempt of awakeTurns()) {
      if (!(workbench.context.motion !== 'reduced')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(workbench.context).toEqual({ colorMode: 'dark', motion: 'reduced' });
    expect(workbench.requestedContext).toEqual(workbench.context);
  });

  test('a change that cannot be evaluated gives the request back to the applied context', async () => {
    const workbench = new ThemeWorkbenchState();
    const failing: ThemeEvaluator = {
      async evaluate(source, revision, context) {
        if (context.startsWith('dark')) {
          return { revision, context, ok: false, diagnostics: [] };
        }
        return evaluator.evaluate(source, revision, context);
      },
    };
    const controller = new ThemeBuilderController({
      workbench,
      evaluator: failing,
      persistence: null,
      newId: () => 'theme-failing',
      now: () => '2026-10-14T00:00:00.000Z',
    });
    await controller.start();
    workbench.setContext({ colorMode: 'dark', motion: 'default' });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(workbench.context.colorMode).toBe('light');
    expect(workbench.requestedContext.colorMode).toBe('light');
  });
});

describe('the library', () => {
  test('create, rename with a conflict, duplicate, switch', async () => {
    const { controller } = tab(memoryThemeStore());
    await controller.start();
    const created = await controller.createTheme('Ocean');
    expect(created.ok).toBe(true);
    expect(controller.active?.draft.envelope.name).toBe('Ocean');
    const conflict = controller.renameTheme(controller.library.activeId!, '  cinder DEFAULT ');
    expect(conflict).toMatchObject({ ok: false });
    expect(controller.active?.draft.envelope.name).toBe('Ocean');
    const copy = await controller.duplicateTheme(controller.library.activeId!);
    expect(copy.ok).toBe(true);
    expect(controller.active?.draft.envelope.name).toBe('Ocean 2');
    const ids = controller.activeThemes.map((entry) => entry.draft.envelope.id);
    await controller.switchTheme(ids[0]!);
    expect(controller.library.activeId).toBe(ids[0]!);
  });

  test('delete moves to Trash, restore brings it back, permanent delete removes the record', async () => {
    const store = memoryThemeStore();
    const { controller } = tab(store);
    await controller.start();
    const second = await controller.createTheme('Second');
    if (!second.ok) throw new Error('create failed');
    await controller.deleteTheme(second.id);
    await controller.flush();
    expect(controller.library.entries[second.id]?.trashed).not.toBeNull();
    expect(controller.activeThemes.map((entry) => entry.draft.envelope.name)).toEqual([
      'Cinder default',
    ]);
    expect(store.data.themes.has(second.id)).toBe(true);

    await controller.restoreTheme(second.id);
    await controller.flush();
    expect(controller.library.entries[second.id]?.trashed).toBeNull();

    await controller.deleteTheme(second.id);
    await controller.flush();
    expect(controller.permanentDeleteCopy(second.id)).toContain('embedded Cinder base');
    await controller.permanentlyDeleteTheme(second.id);
    expect(controller.library.entries[second.id]).toBeUndefined();
    expect(store.data.themes.has(second.id)).toBe(false);
  });
});

describe('two tabs', () => {
  async function pair() {
    const store = memoryThemeStore();
    const open = bus();
    const one = tab(store, open());
    const two = tab(store, open());
    await one.controller.start();
    await one.controller.flush();
    await two.controller.start();
    return { store, one, two };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  test('a clean tab reloads the newer revision and announces it', async () => {
    const { one, two } = await pair();
    await one.controller.commit(setRadius(8));
    await one.controller.flush();
    await settle();
    expect(two.controller.draft!.envelope.overrides.shared).toEqual({ radius: { medium: px(8) } });
    expect(two.controller.announcement).toContain('another tab');
    expect(two.controller.conflict).toBeNull();
  });

  test('partial input that was already autosaved still counts as unsaved work in a conflict', async () => {
    const { one, two } = await pair();
    two.controller.setInputBuffer('radius.medium@source', { text: '{"va', error: null });
    await two.controller.flush();
    expect(two.workbench.saveStatus).toBe('saved');
    await one.controller.commit(setRadius(8));
    await one.controller.flush();
    await settle();
    expect(two.controller.conflict).not.toBeNull();
    expect(two.controller.draft!.inputBuffer['radius.medium@source']?.text).toBe('{"va');
  });

  test('a dirty tab is never overwritten and can reload the stored version or save a copy', async () => {
    const { one, two } = await pair();
    two.controller.setInputBuffer('radius.medium@source', { text: '{"va', error: null });
    await one.controller.commit(setRadius(8));
    await one.controller.flush();
    await settle();
    expect(two.controller.conflict).not.toBeNull();
    expect(two.controller.draft!.inputBuffer['radius.medium@source']?.text).toBe('{"va');

    await two.controller.reloadStoredVersion();
    expect(two.controller.conflict).toBeNull();
    expect(two.controller.draft!.inputBuffer).toEqual({});
    expect(two.controller.draft!.envelope.overrides.shared).toEqual({ radius: { medium: px(8) } });

    two.controller.setInputBuffer('radius.medium@source', { text: 'x', error: null });
    await one.controller.commit(setRadius(9));
    await one.controller.flush();
    await settle();
    expect(two.controller.conflict).not.toBeNull();
    const copy = await two.controller.saveConflictAsCopy();
    expect(copy.ok).toBe(true);
    expect(two.controller.active?.draft.envelope.name).toBe('Cinder default 2');
    expect(two.controller.conflict).toBeNull();
  });
});
