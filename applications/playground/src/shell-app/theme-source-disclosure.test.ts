/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import { flushSync } from 'svelte';

import { catalogueRowByPath } from './theme-builder-catalogue.ts';
import { fixtureDraft } from './theme-reference-fixtures.ts';
import { overlayTokens, useHarness } from './theme-reference-test-support.ts';
import ThemeSourceDisclosure from './theme-source-disclosure.svelte';
import { inspectToken } from './theme-source-inspection.ts';
import { sourceTokenRow } from './theme-source-token-row.ts';
import ThemeWorkbenchEditor from './theme-workbench-editor.svelte';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

setupHappyDom();
const h = useHarness();
const { settle, start, byLabel, click } = h;
const rowOf = (path: string) => sourceTokenRow(path, 'dimension');

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

describe('the Source and dependencies disclosure', () => {
  async function mountDisclosure(row: ReturnType<typeof rowOf>, open = true) {
    const { controller, workbench } = await start();
    workbench.sourceDisclosureOpen = open;
    h.mount(ThemeSourceDisclosure, { controller, workbench, row });
    await settle();
    await settle();
    return { controller, workbench };
  }

  test('nothing is computed until it opens, and it describes the token', async () => {
    const { workbench } = await mountDisclosure(catalogueRowByPath('radius.large')!, false);
    expect(h.target.querySelector('[data-testid="source-revision"]')).toBeNull();
    workbench.sourceDisclosureOpen = true;
    await settle();
    await settle();
    expect(h.target.querySelector('[data-testid="source-revision"]')).not.toBeNull();
    expect(h.target.querySelectorAll('[data-context]')).toHaveLength(6);
    expect(h.target.querySelector('[data-testid="source-disposition"]')!.textContent).toContain(
      'Portable export: complete',
    );
    expect(h.target.textContent).toContain('border-radius');
  });

  test('a Source-only token says so and invents no property', async () => {
    await mountDisclosure(rowOf('fx.c'));
    expect(h.target.querySelector('[data-testid="source-only"]')!.textContent).toContain(
      'Source only',
    );
    expect(h.target.textContent).not.toContain('--cinder-fx');
    expect(h.target.textContent).toContain('fx.probe');
    expect(h.target.querySelector('[data-testid="source-disposition"]')!.textContent).toContain(
      'CSS export: none',
    );
  });

  test('a token with no dependents says so in every context', async () => {
    await mountDisclosure(rowOf('fx.probe'));
    expect(h.target.querySelectorAll('[data-testid="no-dependents"]')).toHaveLength(6);
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
    expect(h.target.querySelector('[data-testid="source-stale"]')!.textContent).toContain(
      `revision ${shown}`,
    );
  });
});

describe('following a dependent and returning', () => {
  test('Follow selects the dependent through the workbench; Back returns and refocuses the trigger', async () => {
    const { controller, workbench } = await start();
    workbench.selectToken('radius.large');
    workbench.sourceDisclosureOpen = true;
    h.mount(ThemeWorkbenchEditor, { workbench, controller });
    await settle();
    await settle();
    expect(h.target.querySelector('[data-testid="selected-token-path"]')!.textContent).toBe(
      'radius.large',
    );
    expect(byLabel('Back to originating token radius.large')).toBeUndefined();
    await click('Follow dependent overlay.radius');
    expect(workbench.selectedTokenPath).toBe('overlay.radius');
    expect(workbench.originTokenPath).toBe('radius.large');
    expect(h.target.querySelector('[data-testid="selected-token-path"]')!.textContent).toBe(
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
