/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { flushSync, mount, tick, unmount } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

import { cinderThemeBase } from './theme-builder-base.ts';
import { catalogueRowByPath, catalogueRows } from './theme-builder-catalogue.ts';
import { tab } from './theme-builder-test-support.ts';
import { memoryThemeStore } from './theme-draft-test-support.ts';
import { createEnvelope } from './theme-envelope.ts';
import { overriddenPaths } from './theme-override-tree.ts';
import {
  buildEdit,
  defaultScope,
  literalValueOf,
  overrideScopeFor,
  parseValueText,
  scopeOptions,
  sourcePathOf,
  usageViolation,
} from './theme-token-edit.ts';
import GenericTokenEditor from './theme-token-editor-generic.svelte';

setupHappyDom();

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

async function open(path: string) {
  const harness = tab(memoryThemeStore());
  await harness.controller.start();
  const row = catalogueRowByPath(path);
  if (row === undefined) throw new Error(`no row ${path}`);
  mounted = mount(GenericTokenEditor, {
    target,
    props: { controller: harness.controller, workbench: harness.workbench, row },
  });
  flushSync();
  await tick();
  return { ...harness, row };
}

const field = () =>
  target.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')!;
const button = (label: string) =>
  [...target.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );

async function type(text: string): Promise<void> {
  const input = field();
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  await tick();
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
  await tick();
}

/** The Apply inside the revision-bound impact list, not the editor's own Apply. */
const impactApply = () =>
  [...target.querySelectorAll('[data-testid="impact-list"] button')].find(
    (candidate) => candidate.textContent?.trim() === 'Apply',
  ) as HTMLButtonElement | undefined;

async function applyImpact(): Promise<void> {
  impactApply()!.click();
  await settle();
}

async function click(label: string): Promise<void> {
  const target = button(label);
  if (target === undefined) throw new Error(`no ${label} button`);
  target.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
  await tick();
}

describe('the generic value editor', () => {
  test('labels its field, and labels the Shipped and Draft values separately', async () => {
    await open('radius.medium');
    const input = field();
    const label = target.querySelector(`label[for="${input.id}"]`);
    expect(label?.textContent).toContain('Value ($value)');
    expect(target.querySelector('[data-testid="shipped-value"]')?.textContent).toBe('0.5rem');
    expect(target.querySelector('[data-testid="draft-value"]')?.textContent).toBe('0.5rem');
    const labels = [...target.querySelectorAll('dt')].map((node) => node.textContent);
    expect(labels).toEqual(['Shipped', 'Draft']);
  });

  test('seeds the field with the shipped DTCG literal', async () => {
    await open('radius.medium');
    expect(JSON.parse(field().value)).toEqual({ value: 0.5, unit: 'rem' });
  });

  test('an invalid value stays in the field with aria-invalid and an error, and never commits', async () => {
    const { controller, workbench } = await open('radius.medium');
    await type('{"value": 4');
    await click('Apply');
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(field().value).toBe('{"value": 4');
    expect(target.textContent).toContain('radius.medium');
    expect(controller.history!.entries).toHaveLength(0);
    expect(workbench.previewIsLastValid).toBe(true);
    expect(controller.draft!.inputBuffer['radius.medium@source']?.text).toBe('{"value": 4');
  });

  test('a usage-range violation is refused with the contract’s reason', async () => {
    const { controller } = await open('radius.medium');
    await type('{"value": -3, "unit": "px"}');
    await click('Apply');
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(controller.history!.entries).toHaveLength(0);
  });

  test('Apply commits exactly one transaction; Reset field removes only that override; undo restores it', async () => {
    const { controller, workbench } = await open('radius.medium');
    await type('{"value": 4, "unit": "px"}');
    await click('Apply');
    expect(controller.history!.entries).toHaveLength(1);
    expect(controller.draft!.envelope.overrides.shared).toEqual({
      radius: { medium: { $type: 'dimension', $value: { value: 4, unit: 'px' } } },
    });
    expect(workbench.properties[0]?.value).toBe('4px');
    expect(field().getAttribute('aria-invalid')).toBeNull();

    await click('Reset field');
    expect(controller.history!.entries).toHaveLength(2);
    expect(controller.draft!.envelope.overrides.shared).toEqual({});
    await controller.undo();
    flushSync();
    await tick();
    expect(controller.draft!.envelope.overrides.shared).toEqual({
      radius: { medium: { $type: 'dimension', $value: { value: 4, unit: 'px' } } },
    });
  });

  test('a theme-aware token defaults to the current color mode, others to shared', async () => {
    const aware = catalogueRows.find((row) => row.themeAware && row.edit === 'supported')!;
    const plain = catalogueRowByPath('radius.medium')!;
    expect(defaultScope(aware)).toBe('color-mode');
    expect(defaultScope(plain)).toBe('shared');
  });

  test('an alias is shown as an alias and becomes a literal only through Replace with literal', async () => {
    const alias = catalogueRows.find(
      (row) => row.aliases.length > 0 && row.edit === 'supported' && row.type === 'dimension',
    );
    if (alias === undefined) throw new Error('no dimension alias token in the catalogue');
    const { controller } = await open(alias.path);
    expect(target.querySelector('[data-testid="alias-note"]')).not.toBeNull();
    expect(target.querySelector('input')).toBeNull();
    await click('Replace with literal');
    // Pressing it only proposes: the impact is listed and nothing has changed yet.
    expect(controller.history!.entries).toHaveLength(0);
    expect(target.querySelector('[data-testid="impact-list"]')).not.toBeNull();
    await applyImpact();
    expect(controller.history!.entries).toHaveLength(1);
    expect(target.querySelector('[data-testid="alias-note"]')).toBeNull();
  });

  test('a detach proposal goes stale when the draft moves on, and Apply is disabled', async () => {
    const alias = catalogueRows.find(
      (row) => row.aliases.length > 0 && row.edit === 'supported' && row.type === 'dimension',
    )!;
    const { controller } = await open(alias.path);
    await click('Replace with literal');
    expect(impactApply()!.disabled).toBe(false);
    await controller.commit({
      kind: 'edit',
      label: 'Elsewhere',
      edit: {
        kind: 'set-override',
        scope: 'shared',
        path: 'space.1-5',
        node: { $type: 'dimension', $value: { value: 7, unit: 'px' } },
      },
    });
    await settle();
    expect(target.querySelector('[data-testid="impact-stale"]')).not.toBeNull();
    expect(impactApply()!.disabled).toBe(true);
  });

  test('a CSS-only token edits cssOverrides and never a fake $value', async () => {
    const cssOnly = catalogueRows.find((row) => row.edit === 'css-only');
    if (cssOnly === undefined) throw new Error('no CSS-only token in the catalogue');
    const { controller } = await open(cssOnly.path);
    await type('url(https://example.com/a.png)');
    await click('Apply');
    expect(controller.draft!.envelope.cssOverrides[cssOnly.path]).toBeUndefined();
    expect(target.textContent).toContain('Resource functions');
    expect(target.querySelector('[data-testid="impact-list"]')).toBeNull();
    await type(validCssOnly(cssOnly));
    await click('Apply');
    // The property's before and after are shown, with its dependents, before anything changes.
    expect(controller.draft!.envelope.cssOverrides[cssOnly.path]).toBeUndefined();
    expect(target.querySelector('[data-testid="impact-list"] tbody th code')!.textContent).toBe(
      cssOnly.path,
    );
    await applyImpact();
    expect(controller.draft!.envelope.cssOverrides[cssOnly.path]).toEqual({
      'light/default': validCssOnly(cssOnly),
    });
    expect(controller.draft!.envelope.overrides.shared).toEqual({});
  });
});

/** A value the CSS-only grammar accepts for each of the four CSS-only tokens. */
function validCssOnly(row: { type: string; profile?: { id: string } | undefined }): string {
  if (row.profile?.id === 'aspect-ratio') return '4 / 3';
  if (row.type === 'color') return 'currentColor';
  return row.profile?.id === 'height' ? '12rem' : '80%';
}

describe('the editing rules', () => {
  const envelope = createEnvelope('t', 'T', cinderThemeBase());
  const context = { colorMode: 'dark', motion: 'default' } as const;

  test('parses aliases, JSON, numbers, and plain strings', () => {
    expect(parseValueText('{radius.small}')).toEqual({ ok: true, value: '{radius.small}' });
    expect(parseValueText('{"value": 1}')).toEqual({ ok: true, value: { value: 1 } });
    expect(parseValueText('1.5')).toEqual({ ok: true, value: 1.5 });
    expect(parseValueText('bold')).toEqual({ ok: true, value: 'bold' });
    expect(parseValueText('{"value":')).toMatchObject({ ok: false });
    expect(parseValueText('  ')).toMatchObject({ ok: false });
  });

  test('the motion scope is unavailable in default motion and maps to its override otherwise', () => {
    expect(scopeOptions(context).find((option) => option.value === 'motion-mode')?.disabled).toBe(
      true,
    );
    expect(overrideScopeFor('motion-mode', context)).toBeNull();
    expect(overrideScopeFor('motion-mode', { colorMode: 'dark', motion: 'reduced' })).toBe(
      'reduced',
    );
    expect(
      overrideScopeFor('motion-mode', { colorMode: 'light', motion: 'forced-reduced-motion' }),
    ).toBe('forcedReduced');
    expect(overrideScopeFor('color-mode', context)).toBe('dark');
  });

  test('follows an alias chain to its literal in the context’s layers', () => {
    const row = catalogueRows.find(
      (candidate) => candidate.aliases.length > 0 && candidate.type === 'dimension',
    )!;
    const literal = literalValueOf(envelope, context, row.path);
    expect(typeof literal).toBe('object');
  });

  test('builds an override node that states its type and keeps existing metadata', () => {
    const row = catalogueRowByPath('radius.medium')!;
    const built = buildEdit(row, envelope, context, 'shared', '{"value": 5, "unit": "px"}');
    expect(built).toEqual({
      ok: true,
      edit: {
        kind: 'set-override',
        scope: 'shared',
        path: 'radius.medium',
        node: { $type: 'dimension', $value: { value: 5, unit: 'px' } },
      },
    });
    expect(usageViolation(row, { value: -1, unit: 'px' })).toContain('radius.medium');
    expect(buildEdit(row, envelope, context, null, '1')).toMatchObject({ ok: false });
  });

  test('a token that is also a group keeps its value, edits and resets at its $root', () => {
    expect(sourcePathOf(envelope, 'accent.solid')).toBe('accent.solid.$root');
    expect(sourcePathOf(envelope, 'radius.medium')).toBe('radius.medium');
    const row = catalogueRowByPath('accent.solid')!;
    expect(literalValueOf(envelope, context, 'accent.solid')).toMatchObject({
      colorSpace: 'oklch',
    });
    const built = buildEdit(
      row,
      envelope,
      context,
      'dark',
      '{"colorSpace": "srgb", "components": [0.1, 0.4, 0.8]}',
    );
    expect(built).toMatchObject({
      ok: true,
      edit: { kind: 'set-override', scope: 'dark', path: 'accent.solid.$root' },
    });
  });

  test('the Changed filter sees an override at a $root as that token', () => {
    const changed = overriddenPaths({
      overrides: {
        shared: {},
        light: { accent: { solid: { $root: { $type: 'color', $value: '#fff' } } } },
        dark: {},
        reduced: {},
        forcedReduced: {},
      },
      cssOverrides: {},
    });
    expect([...changed]).toEqual(['accent.solid']);
  });
});
