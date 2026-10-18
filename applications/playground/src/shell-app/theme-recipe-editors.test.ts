/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

import { cinderThemeBase } from './theme-builder-base.ts';
import { catalogueRowByPath } from './theme-builder-catalogue.ts';
import { editableState } from './theme-draft-types.ts';
import { createEnvelope } from './theme-envelope.ts';
import { checksEvaluator, computeChecksDelta } from './theme-impact-checks.ts';
import { isTrustedRecipe, untrustedRecipes } from './theme-recipe-trust.ts';
import ThemeReferencePanel from './theme-reference-panel.svelte';
import { PROBE_TOKENS, useHarness, warmStates } from './theme-reference-test-support.ts';
import { evaluatedThemeOf } from './theme-token-dependents.ts';

setupHappyDom();
const h = useHarness();
const { settle, start, click, typeInto } = h;
// The state `start` seeds is evaluated here, outside any test's budget.
await warmStates(PROBE_TOKENS);

async function mountPanel(row: NonNullable<ReturnType<typeof catalogueRowByPath>>) {
  const { controller, workbench } = await start();
  h.mount(ThemeReferencePanel, { controller, workbench, row });
  await settle();
  return { controller, workbench };
}

describe('recipes', () => {
  const recipeRow = () => catalogueRowByPath('surface.hover')!;

  test('lists the declared inputs and follows one, remembering where it started', async () => {
    const { workbench } = await mountPanel(recipeRow());
    const inputs = [...h.target.querySelectorAll('ul[aria-label="Recipe inputs"] code')].map(
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
    const paths = [...h.target.querySelectorAll('[data-testid="impact-list"] tbody th code')].map(
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
    const select = h.target.querySelector<HTMLSelectElement>('select[id$="-override-scope"]')!;
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
    expect(h.target.querySelector('[data-testid="impact-list"]')).toBeNull();
    expect(h.target.textContent).toContain('surface.hover:');
    expect(controller.draft!.revision).toBe(revision);
    expect(controller.draftValues).toBe(values);
    expect(controller.draft!.envelope.cssOverrides).toEqual({});
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

// --- the checks a proposal moves --------------------------------------------------------------

// Two reports across six contexts each: computed once here, outside any test's time budget.
const pale = { colorSpace: 'srgb', components: [0.96, 0.96, 0.96] };
const base = createEnvelope('checks', 'Checks', cinderThemeBase());
const washedOut = {
  ...base,
  overrides: {
    ...base.overrides,
    light: { text: { default: { $type: 'color', $value: pale } } },
  },
};
const introduced = await computeChecksDelta(checksEvaluator, base, editableState(washedOut));
const resolved = await computeChecksDelta(checksEvaluator, washedOut, editableState(base));
const unchanged = await computeChecksDelta(checksEvaluator, base, editableState(base));

describe('the findings a proposal introduces and resolves', () => {
  test('a change that washes text out introduces accessibility errors, kept apart by severity', () => {
    expect(introduced.ok).toBe(true);
    if (!introduced.ok) return;
    expect(introduced.bySeverity.map((entry) => entry.severity)).toEqual([
      'invalid-source',
      'accessibility-error',
      'needs-review',
      'advisory',
    ]);
    const errors = introduced.bySeverity.find((entry) => entry.severity === 'accessibility-error')!;
    expect(errors.introduced.length).toBeGreaterThan(0);
    expect(errors.introduced.every((finding) => finding.severity === 'accessibility-error')).toBe(
      true,
    );
    expect(errors.introduced.some((finding) => finding.tokenPaths.includes('text.default'))).toBe(
      true,
    );
    expect(errors.resolved).toEqual([]);
  });

  test('reverting that change resolves exactly what it introduced', () => {
    expect(resolved.ok).toBe(true);
    if (!resolved.ok || !introduced.ok) return;
    const introducedIds = introduced.bySeverity.flatMap((entry) =>
      entry.introduced.map((finding) => finding.id),
    );
    const resolvedIds = resolved.bySeverity.flatMap((entry) =>
      entry.resolved.map((finding) => finding.id),
    );
    expect(resolvedIds.toSorted()).toEqual(introducedIds.toSorted());
    expect(resolved.introduced).toBe(0);
  });

  test('a change that touches nothing introduces and resolves nothing', () => {
    expect(unchanged).toMatchObject({ ok: true, introduced: 0, resolved: 0 });
  });

  test('a proposal that makes the source invalid reports the runtime diagnostic', async () => {
    const broken = {
      ...base,
      overrides: {
        ...base.overrides,
        shared: { fx: { a: { $type: 'dimension', $value: '{fx.a}' } } },
      },
    };
    const result = await computeChecksDelta(checksEvaluator, base, editableState(broken));
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('fx');
  });
});
