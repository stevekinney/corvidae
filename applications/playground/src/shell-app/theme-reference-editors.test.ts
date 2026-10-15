/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

import { catalogueRowByPath } from './theme-builder-catalogue.ts';
import { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import { editableState, THEME_CONTEXT_IDS, type JsonObject } from './theme-draft-types.ts';
import { computeImpact, impactIsCurrent } from './theme-impact.ts';
import { jsonEquals } from './theme-override-tree.ts';
import {
  aliasCandidates,
  incompatibility,
  proposeCssOverride,
  proposeDetach,
  proposeRebind,
} from './theme-reference-edits.ts';
import { fixtureDraft } from './theme-reference-fixtures.ts';
import ThemeReferencePanel from './theme-reference-panel.svelte';
import { overlayTokens, PROBE_TOKENS, useHarness } from './theme-reference-test-support.ts';
import { createRuntimeEvaluator } from './theme-runtime-evaluator.ts';
import { sourceTokenRow } from './theme-source-token-row.ts';
import { evaluatedThemeOf } from './theme-token-dependents.ts';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

setupHappyDom();
const h = useHarness();
const { settle, start, byLabel, click, typeInto } = h;

const light = { colorMode: 'light', motion: 'default' } as const;
const rowOf = (path: string) => sourceTokenRow(path, 'dimension');

// The shipped corpus is validated once, outside any test's time budget.
const draft = fixtureDraft();
const baseline = evaluatedThemeOf(draft.envelope);

describe('the fixture', () => {
  test('evaluates, with Source tokens that have no CSS property', () => {
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    expect(baseline.index.get('light/default')!.has('fx.c')).toBe(true);
    expect(Object.values(baseline.properties['light/default']!)).not.toContain(undefined);
  });
});

describe('alias candidates', () => {
  test('are same-effective-type tokens, searchable, never the token or its readers', () => {
    const { items: found, total } = aliasCandidates(draft, rowOf('fx.b'), '', 500);
    const paths = found.map((candidate) => candidate.path);
    expect(paths).toContain('fx.other');
    expect(paths).toContain('radius.small');
    expect(paths).not.toContain('fx.b');
    expect(paths).not.toContain('fx.c');
    expect(found.every((candidate) => candidate.type === 'dimension')).toBe(true);
    expect(paths).not.toContain('surface.base');
    expect(total).toBe(found.length);
  });

  test('a long list is bounded and says how many there are', () => {
    const { items, total } = aliasCandidates(draft, rowOf('fx.b'), '', 5);
    expect(items).toHaveLength(5);
    expect(total).toBeGreaterThan(5);
  });

  test('search narrows by path', () => {
    const { items: found } = aliasCandidates(draft, rowOf('fx.b'), 'radius.sm');
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((candidate) => candidate.path.includes('radius.sm'))).toBe(true);
  });
});

describe('rejections carry a path-addressed diagnostic', () => {
  test('a type mismatch names both types and the context', () => {
    const message = incompatibility(draft, rowOf('fx.b'), 'surface.base');
    expect(message).toContain('fx.b');
    expect(message).toContain('surface.base is color');
    expect(message).toContain('this token is dimension');
  });

  test('a missing target', () => {
    expect(incompatibility(draft, rowOf('fx.b'), 'fx.nowhere')).toBe(
      'fx.b: fx.nowhere does not exist, so it cannot be an alias target.',
    );
  });

  test('a cycle through a dependent, and self', () => {
    expect(incompatibility(draft, rowOf('fx.a'), 'fx.c')).toContain('would be a cycle');
    expect(incompatibility(draft, rowOf('fx.a'), 'fx.a')).toContain('cannot alias itself');
  });

  test('a rejected proposal changes nothing and reports the same path', () => {
    const before = JSON.stringify(draft.envelope);
    const proposal = proposeRebind(draft, rowOf('fx.b'), light, 'shared', 'surface.base');
    expect(proposal.ok).toBe(false);
    expect(proposal.ok ? '' : proposal.path).toBe('fx.b');
    expect(JSON.stringify(draft.envelope)).toBe(before);
  });

  test('the runtime refuses what the pre-checks cannot see', () => {
    const impact = computeImpact(draft, 'fx.b', [
      {
        kind: 'set-override',
        scope: 'shared',
        path: 'fx.b',
        node: { $type: 'dimension', $value: '{fx.c}' },
      },
    ]);
    expect(impact.ok).toBe(false);
    expect(impact.ok ? '' : impact.message).toContain('fx');
  });
});

describe('impact preview', () => {
  const chain = PROBE_TOKENS;
  const withProbe = fixtureDraft(chain, 'chain');
  const other = (path: string) => `{${path}}`;

  test('two hops: rebinding the middle of a chain lists each changed dependent once per context', () => {
    const proposal = proposeRebind(withProbe, rowOf('fx.b'), light, 'shared', 'fx.other');
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    const { changed, unchanged } = proposal.impact;
    const paths = [...new Set(changed.map((row) => row.path))].toSorted();
    expect(paths).toEqual(['fx.b', 'fx.c', 'fx.diamond', 'fx.probe']);
    const keys = changed.map((row) => `${row.path}@${row.context}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const context of THEME_CONTEXT_IDS) {
      const row = changed.find((item) => item.path === 'fx.c' && item.context === context)!;
      expect(row.role).toBe('dependent');
      expect(row.before).not.toBe(row.after);
    }
    expect(unchanged).toBe(0);
    const target = changed.find((row) => row.role === 'target')!;
    expect(target.authored).toEqual({ before: other('fx.a'), after: other('fx.other') });
  });

  test('a diamond lists its sink once per context', () => {
    const proposal = proposeCssOrValue(withProbe, 'fx.a');
    expect(proposal.filter((row) => row.path === 'fx.diamond')).toHaveLength(6);
  });

  test('a token with no dependents still shows its own change', () => {
    const proposal = proposeRebind(withProbe, rowOf('fx.probe'), light, 'shared', 'fx.other');
    expect(proposal.ok && proposal.impact.changed.map((row) => row.path)).toEqual(
      Array(6).fill('fx.probe'),
    );
  });

  test('detaching changes the representation but not a value, and unchanged dependents are counted', () => {
    const proposal = proposeDetach(withProbe, rowOf('fx.b'), light, 'shared');
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    const { changed, unchanged } = proposal.impact;
    expect(changed.every((row) => row.role === 'target')).toBe(true);
    expect(changed).toHaveLength(6);
    expect(changed[0]!.authored!.before).toBe('{fx.a}');
    expect(changed[0]!.authored!.after).toBe('{"value":4,"unit":"px"}');
    expect(unchanged).toBeGreaterThan(0);
  });

  test('detaching severs only the selected reference', () => {
    const proposal = proposeDetach(withProbe, rowOf('fx.b'), light, 'shared');
    if (!proposal.ok) throw new Error(proposal.message);
    const next = JSON.stringify(proposal.impact.state.overrides.shared);
    expect(next).toContain('"fx.a"'.replace('"fx.a"', '{"value":4'));
    expect(next).toContain('{fx.b}');
    expect(next).toContain('{fx.a}');
  });

  test('a recipe override lists the token and every dependent it changes, deduplicated', () => {
    const proposal = proposeCssOverride(
      fixtureDraft(),
      catalogueRowByPath('accent.solid')!,
      ['light/default'],
      'oklch(55% 0.2 270)',
      null,
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    const paths = new Set(proposal.impact.changed.map((row) => row.path));
    expect(paths.has('accent.solid')).toBe(true);
    expect(paths.has('accent.solid.hover')).toBe(true);
    expect(proposal.impact.changed.every((row) => row.context === 'light/default')).toBe(true);
  });

  test('a rejected CSS value is never previewed', () => {
    for (const text of ['url(https://example.com/x)', 'red; background: blue', '']) {
      const proposal = proposeCssOverride(
        fixtureDraft(),
        catalogueRowByPath('accent.solid')!,
        ['light/default'],
        text,
        null,
      );
      expect(proposal.ok).toBe(false);
    }
  });

  test('an invalid or cyclic result is a diagnostic, not a preview', () => {
    const cyclic = computeImpact(withProbe, 'fx.a', [
      {
        kind: 'set-override',
        scope: 'shared',
        path: 'fx.a',
        node: { $type: 'dimension', $value: '{fx.c}' },
      },
    ]);
    expect(cyclic.ok).toBe(false);
    expect(cyclic.ok ? '' : cyclic.message).toMatch(/cycle|circular/i);
  });

  test('a stale revision is detected', () => {
    const proposal = proposeRebind(withProbe, rowOf('fx.b'), light, 'shared', 'fx.other');
    if (!proposal.ok) throw new Error(proposal.message);
    expect(impactIsCurrent(proposal.impact, withProbe)).toBe(true);
    expect(
      impactIsCurrent(proposal.impact, { ...withProbe, revision: withProbe.revision + 1 }),
    ).toBe(false);
    expect(impactIsCurrent(proposal.impact, null)).toBe(false);
  });
});

function proposeCssOrValue(source: ReturnType<typeof fixtureDraft>, target: string) {
  const impact = computeImpact(source, target, [
    {
      kind: 'set-override',
      scope: 'shared',
      path: target,
      node: { $type: 'dimension', $value: { value: 16, unit: 'px' } },
    },
  ]);
  if (!impact.ok) throw new Error(impact.message);
  return impact.changed;
}

describe('apply and undo through the controller', () => {
  const evaluator = createRuntimeEvaluator();

  async function start() {
    const workbench = new ThemeWorkbenchState();
    const controller = new ThemeBuilderController({ workbench, evaluator, persistence: null });
    await controller.start();
    const seeded = await controller.commit({
      kind: 'edit',
      label: 'Seed',
      state: editableState(fixtureDraft(overlayTokens({}), 'seed').envelope),
    });
    expect(seeded.ok).toBe(true);
    return controller;
  }

  test('one apply and one undo restore the value and the graph exactly', async () => {
    const controller = await start();
    const row = rowOf('fx.b');
    const before = controller.draft!;
    const beforeGraph = JSON.stringify(
      [
        ...(evaluatedThemeOf(before.envelope).ok
          ? (evaluatedThemeOf(before.envelope) as never as { index: Map<string, unknown> }).index
          : []),
      ].map(([context, tokens]) => [
        context,
        [...(tokens as Map<string, { dependents: unknown }>)].map(([p, t]) => [p, t.dependents]),
      ]),
    );
    const proposal = proposeRebind(before, row, light, 'shared', 'fx.other');
    if (!proposal.ok) throw new Error(proposal.message);
    const entries = controller.history!.entries.length;
    const outcome = await controller.commit({
      kind: 'edit',
      label: 'Rebind fx.b',
      state: proposal.impact.state,
    });
    expect(outcome).toEqual({ ok: true, changed: true });
    expect(controller.history!.entries.length).toBe(entries + 1);
    expect(controller.draft!.revision).toBe(before.revision + 1);
    await controller.undo();
    expect(jsonEquals(controller.draft!.envelope.overrides, before.envelope.overrides)).toBe(true);
    const afterUndo = evaluatedThemeOf(controller.draft!.envelope);
    expect(afterUndo.ok).toBe(true);
    const graph = JSON.stringify(
      [...(afterUndo as never as { index: Map<string, unknown> }).index].map(
        ([context, tokens]) => [
          context,
          [...(tokens as Map<string, { dependents: unknown }>)].map(([p, t]) => [p, t.dependents]),
        ],
      ),
    );
    expect(graph).toBe(beforeGraph);
  });

  test('a failed proposal leaves source, history and preview unchanged', async () => {
    const controller = await start();
    const before = controller.draft!;
    const values = controller.draftValues;
    const entries = controller.history!.entries.length;
    const outcome = await controller.commit({
      kind: 'edit',
      label: 'Bad',
      state: {
        ...editableState(before.envelope),
        overrides: {
          ...before.envelope.overrides,
          shared: {
            ...before.envelope.overrides.shared,
            fx: { a: { $type: 'dimension', $value: '{fx.c}' } },
          },
        },
      },
    });
    expect(outcome.ok).toBe(false);
    expect(controller.draft).toBe(before);
    expect(controller.draftValues).toBe(values);
    expect(controller.history!.entries.length).toBe(entries);
  });
});

const aliasRow = () => ({ ...rowOf('fx.b'), aliases: ['fx.a'], themeAware: true });
const lightFx = (controller: ThemeBuilderController) =>
  controller.draft!.envelope.overrides.light['fx'] as JsonObject | undefined;

async function mountPanel(row: ReturnType<typeof aliasRow>) {
  const { controller, workbench } = await start();
  h.mount(ThemeReferencePanel, { controller, workbench, row });
  await settle();
  return { controller, workbench };
}

describe('rebinding an alias', () => {
  test('the picker lists compatible tokens, and choosing one previews before anything changes', async () => {
    const { controller } = await mountPanel(aliasRow());
    expect(h.target.querySelector('[data-testid="reference-alias"]')).not.toBeNull();
    await click('Rebind alias');
    await typeInto('-search', 'fx.oth');
    expect(h.target.querySelectorAll('[data-testid="alias-candidates"] li')).toHaveLength(1);
    const revision = controller.draft!.revision;
    await click('Alias fx.b to fx.other');
    expect(h.target.querySelector('[data-testid="impact-list"]')).not.toBeNull();
    expect(h.target.querySelector('[data-testid="impact-summary"]')!.textContent).toContain(
      'tokens change',
    );
    expect(controller.draft!.revision).toBe(revision);
    expect(lightFx(controller)).toBeUndefined();
  });

  test('Apply is one transaction and one Undo restores the draft exactly', async () => {
    const { controller } = await mountPanel(aliasRow());
    const before = controller.draft!.envelope.overrides;
    const entries = controller.history!.entries.length;
    await click('Rebind alias');
    await typeInto('-search', 'fx.oth');
    await click('Alias fx.b to fx.other');
    await click('Apply');
    expect(controller.history!.entries.length).toBe(entries + 1);
    expect((lightFx(controller)!['b'] as JsonObject)['$value']).toBe('{fx.other}');
    expect(controller.announcement).toContain('Rebind fx.b to fx.other');
    expect(h.target.querySelector('[data-testid="impact-list"]')).toBeNull();
    await controller.undo();
    expect(jsonEquals(controller.draft!.envelope.overrides, before)).toBe(true);
  });

  test('a proposal left open goes stale when the draft moves on, and cannot be applied', async () => {
    const { controller } = await mountPanel(aliasRow());
    await click('Rebind alias');
    await typeInto('-search', 'fx.oth');
    await click('Alias fx.b to fx.other');
    await controller.commit({
      kind: 'edit',
      label: 'Elsewhere',
      edit: {
        kind: 'set-override',
        scope: 'shared',
        path: 'fx.other',
        node: { $type: 'dimension', $value: { value: 9, unit: 'px' } },
      },
    });
    await settle();
    expect(h.target.querySelector('[data-testid="impact-stale"]')).not.toBeNull();
    expect(byLabel('Apply')!.hasAttribute('disabled')).toBe(true);
    const revision = controller.draft!.revision;
    await click('Cancel');
    expect(controller.draft!.revision).toBe(revision);
    expect(h.target.querySelector('[data-testid="impact-list"]')).toBeNull();
  });
});
