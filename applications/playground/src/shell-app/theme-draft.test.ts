import { describe, expect, it } from 'bun:test';

import { EvaluationGate, type ThemeEvaluator } from './theme-draft-evaluation.ts';
import { richNode, testBase } from './theme-draft-test-support.ts';
import {
  editableState,
  inputKey,
  isDirty,
  previewIsStale,
  type ThemeDraft,
} from './theme-draft-types.ts';
import {
  applyEdit,
  commitInput,
  createDraft,
  hasOverridesAt,
  markSaved,
  overrideAt,
  resetDraft,
  restoreState,
  setInput,
  type DraftEdit,
} from './theme-draft.ts';
import { createEnvelope } from './theme-envelope.ts';

const draft = (): ThemeDraft => createDraft(createEnvelope('t1', 'Theme', testBase()));

function must(result: ReturnType<typeof applyEdit>): ThemeDraft {
  if (!result.ok) throw new Error('edit refused');
  return result.draft;
}

const set = (scope: 'shared' | 'light' | 'dark', path: string, node = richNode): DraftEdit => ({
  kind: 'set-override',
  scope,
  path,
  node,
});

describe('draft revisions', () => {
  it('grows the revision monotonically and keeps a no-op edit at the same revision', () => {
    const first = must(applyEdit(draft(), set('light', 'palette.accent')));
    expect(first.revision).toBe(2);
    const same = applyEdit(first, set('light', 'palette.accent'));
    expect(same.ok && same.changed).toBe(false);
    expect(must(same).revision).toBe(2);
    const second = must(applyEdit(first, set('dark', 'palette.accent')));
    expect(second.revision).toBe(3);
  });

  it('keeps authored metadata intact and never edits the embedded base', () => {
    const base = draft();
    const edited = must(applyEdit(base, set('light', 'palette.accent')));
    expect(overrideAt(edited, 'light', 'palette.accent')).toEqual(richNode);
    expect(edited.envelope.base).toBe(base.envelope.base);
    expect(JSON.parse(JSON.stringify(edited.envelope.overrides.light))).toEqual({
      palette: { accent: richNode },
    });
  });

  it('stores CSS-only edits apart from DTCG overrides, keyed by path and context', () => {
    const edited = must(
      applyEdit(draft(), {
        kind: 'set-css-override',
        path: 'palette.accent',
        context: 'dark/reduced',
        value: 'color-mix(in oklab, red 50%, blue)',
      }),
    );
    expect(edited.envelope.cssOverrides).toEqual({
      'palette.accent': { 'dark/reduced': 'color-mix(in oklab, red 50%, blue)' },
    });
    expect(edited.envelope.overrides.dark).toEqual({});
  });
});

describe('reset scopes', () => {
  function populated(): ThemeDraft {
    let current = draft();
    for (const edit of [
      set('shared', 'palette.accent'),
      set('light', 'palette.ink'),
      set('dark', 'palette.ink'),
      set('dark', 'space.md'),
      {
        kind: 'set-css-override',
        path: 'space.md',
        context: 'light/default',
        value: '2rem',
      } as DraftEdit,
      {
        kind: 'set-css-override',
        path: 'space.md',
        context: 'dark/default',
        value: '3rem',
      } as DraftEdit,
    ]) {
      current = must(applyEdit(current, edit));
    }
    return current;
  }

  it('resets a field everywhere and leaves other tokens', () => {
    const reset = must(resetDraft(populated(), { kind: 'field', path: 'space.md' }));
    expect(reset.envelope.overrides.dark).toEqual({ palette: { ink: richNode } });
    expect(reset.envelope.cssOverrides).toEqual({});
    expect(overrideAt(reset, 'light', 'palette.ink')).toEqual(richNode);
  });

  it('resets a category by path prefix only', () => {
    const reset = must(resetDraft(populated(), { kind: 'category', prefix: 'palette' }));
    expect(reset.envelope.overrides.shared).toEqual({});
    expect(reset.envelope.overrides.light).toEqual({});
    expect(reset.envelope.overrides.dark).toEqual({ space: { md: richNode } });
    expect(Object.keys(reset.envelope.cssOverrides)).toEqual(['space.md']);
  });

  it('resets the current color mode without touching the other mode or shared', () => {
    const reset = must(resetDraft(populated(), { kind: 'color-mode', colorMode: 'dark' }));
    expect(reset.envelope.overrides.dark).toEqual({});
    expect(reset.envelope.cssOverrides).toEqual({ 'space.md': { 'light/default': '2rem' } });
    expect(overrideAt(reset, 'light', 'palette.ink')).toEqual(richNode);
    expect(overrideAt(reset, 'shared', 'palette.accent')).toEqual(richNode);
  });

  it('resets the whole theme and still never edits the base', () => {
    const before = populated();
    const reset = must(resetDraft(before, { kind: 'theme' }));
    expect(editableState(reset.envelope).cssOverrides).toEqual({});
    expect(
      Object.values(reset.envelope.overrides).every((tree) => Object.keys(tree).length === 0),
    ).toBe(true);
    expect(reset.envelope.base).toBe(before.envelope.base);
  });

  it('treats a reset with nothing to remove as no change', () => {
    const result = resetDraft(draft(), { kind: 'category', prefix: 'palette' });
    expect(result.ok && result.changed).toBe(false);
    expect(hasOverridesAt(draft(), { kind: 'theme' })).toBe(false);
    expect(hasOverridesAt(populated(), { kind: 'theme' })).toBe(true);
  });
});

describe('invalid-input buffer', () => {
  it('keeps partial text apart from the last-valid revision and labels the preview stale', () => {
    const start = draft();
    const typing = setInput(start, inputKey('palette.ink', 'light/default'), {
      text: '#12',
      error: 'Incomplete',
    });
    expect(typing.revision).toBe(start.revision);
    expect(typing.envelope).toBe(start.envelope);
    expect(previewIsStale(typing)).toBe(true);
    expect(isDirty(typing)).toBe(true);
    const committed = commitInput(
      typing,
      inputKey('palette.ink', 'light/default'),
      set('light', 'palette.ink'),
    );
    expect(committed.ok && committed.draft.inputBuffer).toEqual({});
    expect(committed.ok && previewIsStale(committed.draft)).toBe(false);
  });

  it('stays dirty for edits that land while a save is in flight', () => {
    const edited = must(applyEdit(draft(), set('light', 'palette.ink')));
    const inFlight = edited;
    const later = must(applyEdit(edited, set('dark', 'palette.ink')));
    const after = markSaved(later, inFlight);
    expect(after.savedRevision).toBe(inFlight.revision);
    expect(isDirty(after)).toBe(true);
    expect(isDirty(markSaved(edited, inFlight))).toBe(false);
  });
});

describe('restoring history states', () => {
  it('moves the revision forward on undo, never back', () => {
    const start = draft();
    const edited = must(applyEdit(start, set('light', 'palette.ink')));
    const undone = restoreState(edited, editableState(start.envelope));
    expect(undone.revision).toBe(edited.revision + 1);
    expect(undone.envelope.overrides.light).toEqual({});
  });
});

describe('evaluation gate', () => {
  function deferredEvaluator() {
    const pending: Array<(value: { revision: number; context: 'light/default' }) => void> = [];
    const evaluator: ThemeEvaluator = {
      evaluate: (_source, revision, context) =>
        new Promise((resolve) => {
          pending.push(() =>
            resolve({
              revision,
              context,
              ok: true,
              properties: [{ name: '--x', value: String(revision) }],
            }),
          );
        }),
    };
    return {
      evaluator,
      release: (index: number) => pending[index]?.({ revision: 0, context: 'light/default' }),
    };
  }

  it('ignores a response once a newer edit has been requested', async () => {
    const { evaluator, release } = deferredEvaluator();
    const gate = new EvaluationGate();
    const source = draft().envelope;
    const first = gate.request(evaluator, 't1', source, 1, 'light/default');
    const second = gate.request(evaluator, 't1', source, 2, 'light/default');
    release(0);
    release(1);
    expect(await first).toBeNull();
    const settled = await second;
    expect(settled?.revision).toBe(2);
  });

  it('ignores a response after a theme switch', async () => {
    const { evaluator, release } = deferredEvaluator();
    const gate = new EvaluationGate();
    const pending = gate.request(evaluator, 't1', draft().envelope, 1, 'light/default');
    gate.invalidate();
    release(0);
    expect(await pending).toBeNull();
  });

  it('ignores a response tagged for another revision or context', async () => {
    const gate = new EvaluationGate();
    const liar: ThemeEvaluator = {
      evaluate: async () => ({ revision: 9, context: 'light/default', ok: true, properties: [] }),
    };
    expect(await gate.request(liar, 't1', draft().envelope, 1, 'light/default')).toBeNull();
    const wrongContext: ThemeEvaluator = {
      evaluate: async (_s, revision) => ({
        revision,
        context: 'dark/default',
        ok: true,
        properties: [],
      }),
    };
    expect(await gate.request(wrongContext, 't1', draft().envelope, 1, 'light/default')).toBeNull();
  });
});
