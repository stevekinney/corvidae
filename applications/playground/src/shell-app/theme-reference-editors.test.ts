/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { flushSync, mount, tick, unmount } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

import { cinderThemeBase } from './theme-builder-base.ts';
import { catalogueRowByPath } from './theme-builder-catalogue.ts';
import { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import { editableState, THEME_CONTEXT_IDS, type JsonObject } from './theme-draft-types.ts';
import { createEnvelope } from './theme-envelope.ts';
import { computeImpact, impactIsCurrent } from './theme-impact.ts';
import { jsonEquals } from './theme-override-tree.ts';
import { isTrustedRecipe, untrustedRecipes } from './theme-recipe-trust.ts';
import {
  aliasCandidates,
  incompatibility,
  proposeCssOverride,
  proposeDetach,
  proposeRebind,
} from './theme-reference-edits.ts';
import { fixtureDraft, SOURCE_TOKENS } from './theme-reference-fixtures.ts';
import ThemeReferencePanel from './theme-reference-panel.svelte';
import { createRuntimeEvaluator } from './theme-runtime-evaluator.ts';
import ThemeSourceDisclosure from './theme-source-disclosure.svelte';
import { inspectToken } from './theme-source-inspection.ts';
import { sourceTokenRow } from './theme-source-token-row.ts';
import { evaluatedThemeOf } from './theme-token-dependents.ts';
import ThemeWorkbenchEditor from './theme-workbench-editor.svelte';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

setupHappyDom();

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

describe('the Source and dependencies model', () => {
  const chain = fixtureDraft(
    overlayTokens({ probe: { $type: 'dimension', $value: '{fx.c}' } }),
    'inspect',
  );

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
    expect(result.inspection.contexts.every((context) => context.dependents.length === 0)).toBe(
      true,
    );
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

// --- the mounted panels ---------------------------------------------------------------------

const evaluator = createRuntimeEvaluator();
let mounted: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

beforeEach(() => {
  target = document.createElement('div');
  document.body.append(target);
});

afterEach(() => {
  if (mounted !== null) void unmount(mounted);
  mounted = null;
  target.remove();
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
  await tick();
}

async function start(
  source: JsonObject = overlayTokens({ probe: { $type: 'dimension', $value: '{fx.c}' } }),
) {
  const workbench = new ThemeWorkbenchState();
  const controller = new ThemeBuilderController({ workbench, evaluator, persistence: null });
  await controller.start();
  const seeded = await controller.commit({
    kind: 'edit',
    label: 'Seed',
    state: editableState(fixtureDraft(source, 'mounted').envelope),
  });
  expect(seeded.ok).toBe(true);
  return { controller, workbench };
}

const byLabel = (label: string) =>
  [...target.querySelectorAll('button')].find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label,
  );

async function click(label: string): Promise<void> {
  const element = byLabel(label);
  if (element === undefined) throw new Error(`No button “${label}”.`);
  element.click();
  await settle();
}

async function typeInto(id: string, text: string): Promise<void> {
  const element = target.querySelector<HTMLInputElement>(`input[id$="${id}"]`)!;
  element.value = text;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
}

const aliasRow = () => ({ ...rowOf('fx.b'), aliases: ['fx.a'], themeAware: true });
const lightFx = (controller: ThemeBuilderController) =>
  (controller.draft!.envelope.overrides.light as JsonObject)['fx'] as JsonObject | undefined;

async function mountPanel(
  row: ReturnType<typeof aliasRow> | ReturnType<typeof catalogueRowByPath>,
) {
  const { controller, workbench } = await start();
  mounted = mount(ThemeReferencePanel, { target, props: { controller, workbench, row: row! } });
  await settle();
  return { controller, workbench };
}

describe('rebinding an alias', () => {
  test('the picker lists compatible tokens, and choosing one previews before anything changes', async () => {
    const { controller } = await mountPanel(aliasRow());
    expect(target.querySelector('[data-testid="reference-alias"]')).not.toBeNull();
    await click('Rebind alias');
    await typeInto('-search', 'fx.oth');
    expect(target.querySelectorAll('[data-testid="alias-candidates"] li')).toHaveLength(1);
    const revision = controller.draft!.revision;
    await click('Alias fx.b to fx.other');
    expect(target.querySelector('[data-testid="impact-list"]')).not.toBeNull();
    expect(target.querySelector('[data-testid="impact-summary"]')!.textContent).toContain(
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
    expect(target.querySelector('[data-testid="impact-list"]')).toBeNull();
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
    expect(target.querySelector('[data-testid="impact-stale"]')).not.toBeNull();
    expect(byLabel('Apply')!.hasAttribute('disabled')).toBe(true);
    const revision = controller.draft!.revision;
    await click('Cancel');
    expect(controller.draft!.revision).toBe(revision);
    expect(target.querySelector('[data-testid="impact-list"]')).toBeNull();
  });

  test('Replace with literal previews first, then writes the literal and keeps dependents', async () => {
    const { controller } = await mountPanel(aliasRow());
    await click('Preview replacing with literal');
    expect(lightFx(controller)).toBeUndefined();
    expect(target.querySelector('[data-testid="impact-unchanged"]')).not.toBeNull();
    await click('Apply');
    expect((lightFx(controller)!['b'] as JsonObject)['$value']).toEqual({ value: 4, unit: 'px' });
  });
});

describe('recipes', () => {
  const recipeRow = () => catalogueRowByPath('surface.hover')!;

  test('lists the declared inputs and follows one, remembering where it started', async () => {
    const { workbench } = await mountPanel(recipeRow());
    const inputs = [...target.querySelectorAll('ul[aria-label="Recipe inputs"] code')].map(
      (element) => element.textContent,
    );
    expect(inputs).toEqual(recipeRow().recipeInputs.slice());
    await click('Edit recipe input surface.base');
    expect(workbench.selectedTokenPath).toBe('surface.base');
    expect(workbench.originTokenPath).toBe('surface.hover');
  });

  test('a complete CSS value is validated, previewed with its dependents, and applied once', async () => {
    const { controller } = await mountPanel(recipeRow());
    await typeInto('-override', 'oklch(55% 0.2 270)');
    await click('Preview CSS override');
    const paths = [...target.querySelectorAll('[data-testid="impact-list"] tbody th code')].map(
      (element) => element.textContent,
    );
    expect(paths).toContain('surface.hover');
    expect(controller.draft!.envelope.cssOverrides).toEqual({});
    const entries = controller.history!.entries.length;
    await click('Apply');
    expect(controller.history!.entries.length).toBe(entries + 1);
    expect(controller.draft!.envelope.cssOverrides['surface.hover']).toEqual({
      'light/default': 'oklch(55% 0.2 270)',
    });
    expect(controller.draftValues.get(recipeRow().cssProperty)).toBe('oklch(55% 0.2 270)');
    await controller.undo();
    expect(controller.draft!.envelope.cssOverrides).toEqual({});
  });

  test('all six contexts take the same override in one transaction', async () => {
    const { controller } = await mountPanel(recipeRow());
    const select = target.querySelector<HTMLSelectElement>('select[id$="-override-scope"]')!;
    select.value = 'all';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await typeInto('-override', 'oklch(55% 0.2 270)');
    await click('Preview CSS override');
    await click('Apply');
    expect(Object.keys(controller.draft!.envelope.cssOverrides['surface.hover']!)).toHaveLength(6);
  });

  test.each([
    'url(https://example.com/x.png)',
    'red; background: blue',
    '}',
    '@import "x"',
    'oklch(55% 0.2 270) !important',
    'expression(alert(1))',
    '',
  ])('rejects %j with a path-addressed message and changes nothing', async (value) => {
    const { controller } = await mountPanel(recipeRow());
    const revision = controller.draft!.revision;
    const values = controller.draftValues;
    await typeInto('-override', value);
    await click('Preview CSS override');
    expect(target.querySelector('[data-testid="impact-list"]')).toBeNull();
    expect(target.textContent).toContain('surface.hover:');
    expect(controller.draft!.revision).toBe(revision);
    expect(controller.draftValues).toBe(values);
    expect(controller.draft!.envelope.cssOverrides).toEqual({});
  });

  test('replacing the recipe with a literal previews it and Undo restores the trusted recipe', async () => {
    const { controller } = await mountPanel(recipeRow());
    const before = controller.draftValues.get(recipeRow().cssProperty);
    await click('Preview replacing recipe with literal');
    expect(target.querySelector('[data-testid="impact-list"]')).not.toBeNull();
    await click('Apply');
    await controller.undo();
    expect(controller.draftValues.get(recipeRow().cssProperty)).toBe(before);
    expect(jsonEquals(controller.draft!.envelope.overrides.light, {})).toBe(true);
  });
});

describe('recipe trust', () => {
  test('the shipped base trusts every recipe it declares', () => {
    const envelope = createEnvelope('shipped', 'Shipped', cinderThemeBase());
    expect(untrustedRecipes(envelope)).toEqual([]);
  });

  test('an imported recipe is inert: it is kept, flagged, and never reaches the projection', () => {
    const imported = {
      border: {
        ink: {
          $type: 'color',
          $value: { colorSpace: 'srgb', components: [1, 0, 0] },
          $extensions: {
            'com.lostgradient.cinder': { cssRecipe: 'red; background: url(x)', trusted: true },
          },
        },
      },
    };
    const blank = createEnvelope('imported', 'Imported', cinderThemeBase());
    const envelope = { ...blank, overrides: { ...blank.overrides, light: imported } };
    expect(untrustedRecipes(envelope)).toEqual([
      {
        document: 'overrides/light.tokens.json',
        path: 'border.ink',
        recipe: 'red; background: url(x)',
      },
    ]);
    // The envelope still carries the recipe, unchanged.
    expect(JSON.stringify(envelope.overrides.light)).toContain('url(x)');
    const evaluated = evaluatedThemeOf(envelope);
    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) return;
    expect(Object.values(evaluated.properties['light/default']!).join(' ')).not.toContain('url(');
  });

  test('a different digest, or a different recipe under the right digest, earns no trust', () => {
    const base = cinderThemeBase();
    const forged = { ...base, sourceDigest: 'sha256:forged' };
    const [first] = untrustedRecipes(createEnvelope('f', 'f', forged));
    expect(first).toBeDefined();
    expect(isTrustedRecipe(base, first!.path, first!.recipe)).toBe(true);
    expect(isTrustedRecipe(forged, first!.path, first!.recipe)).toBe(false);
    expect(isTrustedRecipe(base, first!.path, `${first!.recipe} `)).toBe(false);
  });
});

describe('the Source and dependencies disclosure', () => {
  async function mountDisclosure(row: ReturnType<typeof rowOf>, open = true) {
    const { controller, workbench } = await start();
    workbench.sourceDisclosureOpen = open;
    mounted = mount(ThemeSourceDisclosure, { target, props: { controller, workbench, row } });
    await settle();
    await settle();
    return { controller, workbench };
  }

  test('nothing is computed until it opens, and it describes the token', async () => {
    const { workbench } = await mountDisclosure(catalogueRowByPath('radius.large')!, false);
    expect(target.querySelector('[data-testid="source-revision"]')).toBeNull();
    workbench.sourceDisclosureOpen = true;
    await settle();
    await settle();
    expect(target.querySelector('[data-testid="source-revision"]')).not.toBeNull();
    expect(target.querySelectorAll('[data-context]')).toHaveLength(6);
    expect(target.querySelector('[data-testid="source-disposition"]')!.textContent).toContain(
      'Portable export: complete',
    );
    expect(target.textContent).toContain('border-radius');
  });

  test('a Source-only token says so and invents no property', async () => {
    await mountDisclosure(rowOf('fx.c'));
    expect(target.querySelector('[data-testid="source-only"]')!.textContent).toContain(
      'Source only',
    );
    expect(target.textContent).not.toContain('--cinder-fx');
    expect(target.textContent).toContain('fx.probe');
    expect(target.querySelector('[data-testid="source-disposition"]')!.textContent).toContain(
      'CSS export: none',
    );
  });

  test('a token with no dependents says so in every context', async () => {
    await mountDisclosure(rowOf('fx.probe'));
    expect(target.querySelectorAll('[data-testid="no-dependents"]')).toHaveLength(6);
  });

  test('a result from an older revision names that revision instead of passing as current', async () => {
    const { controller } = await mountDisclosure(rowOf('fx.c'));
    const shown = controller.draft!.revision;
    await controller.commit({
      kind: 'edit',
      label: 'Move on',
      edit: {
        kind: 'set-override',
        scope: 'shared',
        path: 'fx.other',
        node: { $type: 'dimension', $value: { value: 10, unit: 'px' } },
      },
    });
    flushSync();
    expect(target.querySelector('[data-testid="source-stale"]')!.textContent).toContain(
      `revision ${shown}`,
    );
  });
});

describe('following a dependent and returning', () => {
  test('Follow selects the dependent through the workbench; Back returns and refocuses the trigger', async () => {
    const { controller, workbench } = await start();
    workbench.selectToken('radius.large');
    workbench.sourceDisclosureOpen = true;
    mounted = mount(ThemeWorkbenchEditor, { target, props: { workbench, controller } });
    await settle();
    await settle();
    expect(target.querySelector('[data-testid="selected-token-path"]')!.textContent).toBe(
      'radius.large',
    );
    expect(byLabel('Back to originating token radius.large')).toBeUndefined();
    await click('Follow dependent overlay.radius');
    expect(workbench.selectedTokenPath).toBe('overlay.radius');
    expect(workbench.originTokenPath).toBe('radius.large');
    expect(target.querySelector('[data-testid="selected-token-path"]')!.textContent).toBe(
      'overlay.radius',
    );
    // The originating context is kept.
    expect(workbench.context).toEqual({ colorMode: 'light', motion: 'default' });
    await click('Back to originating token radius.large');
    await settle();
    expect(workbench.selectedTokenPath).toBe('radius.large');
    expect(workbench.originTokenPath).toBeNull();
    expect(document.activeElement?.id).toBe('theme-source-radius-large-header');
    expect(byLabel('Back to originating token radius.large')).toBeUndefined();
  });

  test('picking another token in the catalogue forgets the trail', () => {
    const workbench = new ThemeWorkbenchState();
    workbench.followToken('overlay.radius', 'radius.large');
    expect(workbench.originTokenPath).toBe('radius.large');
    workbench.selectToken('radius.small');
    expect(workbench.originTokenPath).toBeNull();
  });
});
