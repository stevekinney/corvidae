/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';

import { catalogueRowByPath } from './theme-builder-catalogue.ts';
import { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import { jsonEquals } from './theme-override-tree.ts';
import { THEME_CONTEXT_IDS, editableState, type JsonObject } from './theme-draft-types.ts';
import { computeImpact, impactIsCurrent } from './theme-impact.ts';
import {
  aliasCandidates,
  incompatibility,
  proposeCssOverride,
  proposeDetach,
  proposeRebind,
} from './theme-reference-edits.ts';
import { fixtureDraft, SOURCE_TOKENS } from './theme-reference-fixtures.ts';
import { createRuntimeEvaluator } from './theme-runtime-evaluator.ts';
import { sourceTokenRow } from './theme-source-token-row.ts';
import { inspectToken } from './theme-source-inspection.ts';
import { evaluatedThemeOf } from './theme-token-dependents.ts';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

const light = { colorMode: 'light', motion: 'default' } as const;
const rowOf = (path: string) => sourceTokenRow(path, 'dimension');

// The shipped corpus is validated once, outside any test's time budget.
const draft = fixtureDraft();
const baseline = evaluatedThemeOf(draft.envelope);

function overlayTokens(extra: JsonObject): JsonObject {
  return { ...SOURCE_TOKENS, fx: { ...(SOURCE_TOKENS['fx'] as JsonObject), ...extra } };
}

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
      { kind: 'set-override', scope: 'shared', path: 'fx.b', node: { $type: 'dimension', $value: '{fx.c}' } },
    ]);
    expect(impact.ok).toBe(false);
    expect(impact.ok ? '' : impact.message).toContain('fx');
  });
});

describe('impact preview', () => {
  const chain = overlayTokens({ probe: { $type: 'dimension', $value: '{fx.c}' } });
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
      { kind: 'set-override', scope: 'shared', path: 'fx.a', node: { $type: 'dimension', $value: '{fx.c}' } },
    ]);
    expect(cyclic.ok).toBe(false);
    expect(cyclic.ok ? '' : cyclic.message).toMatch(/cycle|circular/i);
  });

  test('a stale revision is detected', () => {
    const proposal = proposeRebind(withProbe, rowOf('fx.b'), light, 'shared', 'fx.other');
    if (!proposal.ok) throw new Error(proposal.message);
    expect(impactIsCurrent(proposal.impact, withProbe)).toBe(true);
    expect(impactIsCurrent(proposal.impact, { ...withProbe, revision: withProbe.revision + 1 })).toBe(
      false,
    );
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
      [...(evaluatedThemeOf(before.envelope).ok ? (evaluatedThemeOf(before.envelope) as never as { index: Map<string, unknown> }).index : [])].map(
        ([context, tokens]) => [context, [...(tokens as Map<string, { dependents: unknown }>)].map(([p, t]) => [p, t.dependents])],
      ),
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
      [...(afterUndo as never as { index: Map<string, unknown> }).index].map(([context, tokens]) => [
        context,
        [...(tokens as Map<string, { dependents: unknown }>)].map(([p, t]) => [p, t.dependents]),
      ]),
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
          shared: { ...before.envelope.overrides.shared, fx: { a: { $type: 'dimension', $value: '{fx.c}' } } },
        },
      },
    });
    expect(outcome.ok).toBe(false);
    expect(controller.draft).toBe(before);
    expect(controller.draftValues).toBe(values);
    expect(controller.history!.entries.length).toBe(entries);
  });
});

describe('the Source and dependencies model', () => {
  const chain = fixtureDraft(overlayTokens({ probe: { $type: 'dimension', $value: '{fx.c}' } }), 'inspect');

  test('shows authored and resolved values, effective type origin, and the winning layer', () => {
    const result = inspectToken(chain.envelope, rowOf('fx.b'));
    if (!result.ok) throw new Error('not ok');
    const context = result.inspection.contexts[0]!;
    expect(context.authored).toBe('{fx.a}');
    expect(context.resolved).toBe('{"value":4,"unit":"px"}');
    expect(context.effectiveType).toBe('dimension');
    expect(context.typeOrigin).toBe('local');
    expect(context.winner.document).toBe('overrides/shared.tokens.json');
    expect(context.references).toEqual(['fx.a']);
    expect(context.dependents).toContain('fx.probe');
    expect(context.dependents).toContain('fx.c');
  });

  test('a Source-only token invents no CSS property and says so', () => {
    const result = inspectToken(chain.envelope, rowOf('fx.b'));
    if (!result.ok) throw new Error('not ok');
    expect(result.inspection.sourceOnly).toBe(true);
    expect(result.inspection.cssProperty).toBeNull();
    expect(result.inspection.cssUsage).toEqual([]);
    expect(result.inspection.disposition).toBeNull();
  });

  test('a public token lists its CSS property, usage, disposition and dependents by context', () => {
    const row = catalogueRowByPath('radius.large')!;
    const result = inspectToken(chain.envelope, row);
    if (!result.ok) throw new Error('not ok');
    const { inspection } = result;
    expect(inspection.cssProperty).toBe(row.cssProperty);
    expect(inspection.cssUsage).toContain('border-radius');
    expect(inspection.disposition?.dtcgExport).toBe('complete');
    expect(inspection.contexts).toHaveLength(6);
    for (const context of inspection.contexts) {
      expect(context.dependents).toEqual(['overlay.radius', 'radius.surface']);
    }
  });

  test('a token with no dependents has an empty list in every context', () => {
    const result = inspectToken(chain.envelope, rowOf('fx.probe'));
    if (!result.ok) throw new Error('not ok');
    expect(result.inspection.contexts.every((context) => context.dependents.length === 0)).toBe(true);
  });

  test('an overridden context names the later winning layer and the layers it beat', () => {
    const overridden = fixtureDraft(
      { fx: { a: { $type: 'dimension', $value: { value: 1, unit: 'px' } } } },
      'layers',
    );
    const lightLayer = {
      ...overridden.envelope,
      overrides: {
        ...overridden.envelope.overrides,
        light: { fx: { a: { $type: 'dimension', $value: { value: 2, unit: 'px' } } } },
      },
    };
    const result = inspectToken(lightLayer, rowOf('fx.a'));
    if (!result.ok) throw new Error('not ok');
    const lightContext = result.inspection.contexts.find((c) => c.context === 'light/default')!;
    const darkContext = result.inspection.contexts.find((c) => c.context === 'dark/default')!;
    expect(lightContext.winner.document).toBe('overrides/light.tokens.json');
    expect(lightContext.overridden.map((layer) => layer.document)).toEqual([
      'overrides/shared.tokens.json',
    ]);
    expect(darkContext.winner.document).toBe('overrides/shared.tokens.json');
  });

  test('an invalid theme yields the path-addressed diagnostics and no provenance', () => {
    const broken = fixtureDraft({ fx: { a: { $type: 'dimension', $value: '{fx.a}' } } }, 'broken');
    const result = inspectToken(broken.envelope, rowOf('fx.a'));
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.diagnostics.length).toBeGreaterThan(0);
  });
});
