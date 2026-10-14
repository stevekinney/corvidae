/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { flushSync, mount, tick, unmount } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

import { buildThemeSources, evaluateThemeProperties } from '@lostgradient/cinder/tokens/runtime';
import { cinderThemeBase } from './theme-builder-base.ts';
import {
  catalogueRowByPath,
  catalogueRows,
  filtersFromSearch,
  rowsForView,
} from './theme-builder-catalogue.ts';
import { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import { evaluator } from './theme-builder-test-support.ts';
import {
  colorFromPicker,
  colorsByMode,
  effectiveBackground,
  pickerBinding,
} from './theme-color-editing.ts';
import ColorTokenEditor from './theme-color-editor.svelte';
import {
  authoredOklch,
  convertTo,
  gamutInfo,
  parseColorText,
  readDtcgColor,
  withChannel,
  type DtcgColor,
} from './theme-color-model.ts';
import ThemeColorSummary from './theme-color-summary.svelte';
import { createEnvelope } from './theme-envelope.ts';
import { dependentsOf } from './theme-token-dependents.ts';
import { overrideValue } from './theme-token-edit.ts';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

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

// Dependents trace the whole theme, so the index is built once at module scope.
const summaryEnvelope = createEnvelope('summary', 'Summary', cinderThemeBase());
const summaryRow = catalogueRowByPath('accent.solid')!;
const accentDependents = dependentsOf(summaryEnvelope, 'light/default', 'accent.solid');

// A Display P3 or out-of-sRGB source reaches CSS in the space it is authored in.
const wideEvaluation = (() => {
  const envelope = createEnvelope('wide', 'Wide', cinderThemeBase());
  const sources = buildThemeSources(
    {
      ...envelope,
      overrides: {
        ...envelope.overrides,
        light: {
          accent: {
            solid: {
              $root: {
                $type: 'color',
                $value: { colorSpace: 'display-p3', components: [0.2, 0.3, 0.9] },
              },
            },
            text: {
              $root: {
                $type: 'color',
                $value: { colorSpace: 'oklch', components: [0.6, 0.35, 150] },
              },
            },
          },
        },
      },
    },
    1,
  );
  return evaluateThemeProperties(sources, { contexts: ['light/default'] });
})();

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
  await tick();
};

/** Poll a condition the app settles asynchronously; the 5 s test budget bounds the wait. */
async function until(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !done(); attempt += 1) await settle();
}

async function open(path: string) {
  const workbench = new ThemeWorkbenchState();
  const controller = new ThemeBuilderController({
    workbench,
    evaluator,
    persistence: null,
  });
  await controller.start();
  const row = catalogueRowByPath(path);
  if (row === undefined) throw new Error(`no row ${path}`);
  const props = { controller, workbench, row };
  mounted = mount(ColorTokenEditor, { target, props });
  await settle();
  return { controller, workbench, row };
}

const byId = <T extends HTMLElement>(id: string) => target.querySelector<T>(`[id="${id}"]`);
const button = (label: string) =>
  [...target.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
const text = (testId: string) =>
  target.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim();

async function type(id: string, value: string): Promise<void> {
  const input = byId<HTMLInputElement>(id);
  if (input === null) throw new Error(`no field ${id}`);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
}

async function press(label: string): Promise<void> {
  const node = button(label);
  if (node === undefined) throw new Error(`no ${label} button`);
  node.click();
  await settle();
}

const lightOverride = (controller: ThemeBuilderController, path: string) =>
  overrideValue(controller.draft!.envelope, 'light', path);

describe('the color editor', () => {
  test('shows rendered color, authored space, alpha, gamut, background, and both modes', async () => {
    await open('accent.solid');
    expect(text('color-space')).toBe('OKLCH');
    expect(text('color-alpha')).toBe('1');
    expect(text('color-gamut')).toBe('Inside sRGB and Display P3');
    expect(text('color-authored-text')).toBe('oklch(0.5 0.22 270)');
    expect(text('color-background')).toContain('surface.base');
    expect(text('compare-light')).toContain('oklch(0.5 0.22 270)');
    expect(text('compare-dark')).toContain('oklch(0.72 0.14 270)');
    const labels = [...target.querySelectorAll('dt')].map((node) => node.textContent);
    expect(labels).toContain('Shipped');
    expect(labels).toContain('Draft');
    expect(
      target.querySelector('[role="img"][aria-label^="Rendered color of accent.solid"]'),
    ).not.toBeNull();
  });

  test('the text field, the channel fields, and Apply edit one authored value', async () => {
    const { controller } = await open('accent.solid');
    const id = 'theme-builder-color-accent-solid';
    await type(`${id}-l-input`, '0.55');
    expect(byId<HTMLInputElement>(`${id}-text`)!.value).toBe('oklch(0.55 0.22 270)');
    await type(`${id}-alpha-input`, '0.5');
    expect(byId<HTMLInputElement>(`${id}-text`)!.value).toBe('oklch(0.55 0.22 270 / 0.5)');
    await type(`${id}-text`, 'oklch(0.6 0.1 250)');
    expect(byId<HTMLInputElement>(`${id}-l-input`)!.value).toBe('0.6');
    expect(byId<HTMLInputElement>(`${id}-c-input`)!.value).toBe('0.1');
    await press('Apply');
    expect(controller.history!.entries).toHaveLength(1);
    expect(lightOverride(controller, 'accent.solid')).toEqual({
      colorSpace: 'oklch',
      components: [0.6, 0.1, 250],
    });
    expect(button('Apply')!.hasAttribute('disabled')).toBe(true);
    expect(controller.draft!.inputBuffer).toEqual({});
  });

  test('invalid text stays visible with an error and never commits', async () => {
    const { controller } = await open('accent.solid');
    const id = 'theme-builder-color-accent-solid-text';
    await type(id, 'oklch(0.6');
    const field = byId<HTMLInputElement>(id)!;
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.value).toBe('oklch(0.6');
    expect(button('Apply')!.hasAttribute('disabled')).toBe(true);
    expect(controller.history!.entries).toHaveLength(0);
  });

  test('light and dark are edited independently and compared without touching the other mode', async () => {
    const { controller, workbench } = await open('accent.solid');
    await type('theme-builder-color-accent-solid-text', 'oklch(0.6 0.1 250)');
    await press('Apply');
    expect(controller.draft!.envelope.overrides.dark).toEqual({});
    expect(controller.draft!.envelope.overrides.shared).toEqual({});
    expect(text('compare-light')).toContain('oklch(0.6 0.1 250)');
    expect(text('compare-dark')).toContain('oklch(0.72 0.14 270)');

    workbench.setContext({ colorMode: 'dark', motion: 'default' });
    await until(() => workbench.context.colorMode === 'dark');
    expect(text('color-authored-text')).toBe('oklch(0.72 0.14 270)');
    await type('theme-builder-color-accent-solid-text', 'oklch(0.8 0.1 200)');
    await press('Apply');
    expect(overrideValue(controller.draft!.envelope, 'dark', 'accent.solid')).toEqual({
      colorSpace: 'oklch',
      components: [0.8, 0.1, 200],
    });
    expect(lightOverride(controller, 'accent.solid')).toEqual({
      colorSpace: 'oklch',
      components: [0.6, 0.1, 250],
    });
    expect(controller.history!.entries).toHaveLength(2);
  });

  test('a Display P3 source is shown as P3 and left alone by the picker', async () => {
    const { controller } = await open('accent.solid');
    const p3 = { colorSpace: 'display-p3', components: [0.2, 0.3, 0.9] };
    await controller.commit({
      kind: 'edit',
      label: 'p3',
      edit: {
        kind: 'set-override',
        scope: 'light',
        path: 'accent.solid.$root',
        node: { $type: 'color', $value: p3 },
      },
    });
    await settle();
    expect(text('color-space')).toBe('Display P3');
    expect(text('color-authored-text')).toBe('color(display-p3 0.2 0.3 0.9)');
    expect(text('picker-preview-note')).toContain('authored in display-p3');
    expect(text('picker-preview-note')).toContain('leaves the source unchanged');
    expect(button('Apply')!.hasAttribute('disabled')).toBe(true);
    expect(lightOverride(controller, 'accent.solid')).toEqual(p3);
    expect(controller.history!.entries).toHaveLength(1);
  });

  test('an out-of-sRGB source is reported, not clamped', async () => {
    const { controller } = await open('accent.solid');
    const wide = { colorSpace: 'oklch', components: [0.6, 0.35, 150] };
    await controller.commit({
      kind: 'edit',
      label: 'wide',
      edit: {
        kind: 'set-override',
        scope: 'light',
        path: 'accent.solid.$root',
        node: { $type: 'color', $value: wide },
      },
    });
    await settle();
    expect(text('color-gamut')).toContain('Outside sRGB');
    expect(text('picker-preview-note')).toContain('outside sRGB');
    expect(lightOverride(controller, 'accent.solid')).toEqual(wide);
  });

  test('an alias stays linked until it is explicitly detached, and undo restores the link', async () => {
    const { controller } = await open('status.neutral.text');
    expect(text('alias-note')).toContain('text.default');
    expect(byId('theme-builder-color-status-neutral-text-text')).toBeNull();
    await press('Detach alias');
    expect(text('color-editor-notice')).toContain('Detached from');
    expect(byId('theme-builder-color-status-neutral-text-text')).not.toBeNull();
    expect(controller.history!.entries).toHaveLength(0);
    await press('Apply');
    expect(controller.history!.entries).toHaveLength(1);
    expect(readDtcgColor(lightOverride(controller, 'status.neutral.text'))).not.toBeNull();
    await controller.undo();
    expect(lightOverride(controller, 'status.neutral.text')).toBeUndefined();
  });

  test('a recipe color is replaced by a literal only on request', async () => {
    await open('surface.hover');
    expect(text('recipe-note')).toContain('trusted CSS recipe');
    expect(button('Replace recipe with literal color')).toBeDefined();
  });

  test('a CSS-only color falls back to the plain CSS editor', async () => {
    const cssOnly = catalogueRows.find((row) => row.type === 'color' && row.edit === 'css-only');
    expect(cssOnly).toBeDefined();
    await open(cssOnly!.path);
    expect(target.querySelector('[data-testid="generic-token-editor"]')).not.toBeNull();
  });
});

describe('wide-gamut sources', () => {
  test('the runtime projects a Display P3 and an out-of-sRGB source unconverted and unclamped', () => {
    expect(wideEvaluation.ok).toBe(true);
    const properties = wideEvaluation.ok ? wideEvaluation.properties['light/default']! : {};
    expect(properties['--cinder-accent-solid']).toBe('color(display-p3 0.2 0.3 0.9)');
    expect(properties['--cinder-accent-text']).toBe('oklch(60% 0.35 150)');
  });
});

describe('dependent roles', () => {
  test('come from the runtime provenance for the active context', () => {
    expect(accentDependents.ok).toBe(true);
    const paths = accentDependents.ok ? accentDependents.paths : [];
    expect(paths).toContain('accent.solid.hover');
    expect(paths).toContain('accent.border');
    expect(paths).toContain('ring.color');
    expect(dependentsOf(summaryEnvelope, 'dark/default', 'accent.solid').ok).toBe(true);
  });

  test('the summary lists them, and following one selects it', async () => {
    const followed: string[] = [];
    const color = readDtcgColor({ colorSpace: 'oklch', components: [0.5, 0.22, 270] })!;
    mounted = mount(ThemeColorSummary, {
      target,
      props: {
        row: summaryRow,
        envelope: summaryEnvelope,
        context: { colorMode: 'light', motion: 'default' },
        color,
        onFollow: (path: string) => followed.push(path),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushSync();
    await press('Dependent roles');
    await until(() => target.querySelector('[data-testid="color-dependents"] button') !== null);
    const links = [
      ...target.querySelectorAll<HTMLButtonElement>('[data-testid="color-dependents"] button'),
    ];
    expect(links.map((link) => link.textContent)).toContain('accent.solid.hover');
    links.find((link) => link.textContent === 'accent.border')!.click();
    expect(followed).toEqual(['accent.border']);
  });
});

describe('the color model keeps the source', () => {
  const oklch = (l: number, c: number, h: number): DtcgColor => ({
    colorSpace: 'oklch',
    components: [l, c, h],
  });

  test('the picker edits an in-gamut sRGB or OKLCH color directly and previews everything else', () => {
    expect(pickerBinding(oklch(0.6, 0.1, 250))).toMatchObject({
      direct: true,
      writeSpace: 'oklch',
    });
    expect(pickerBinding({ colorSpace: 'srgb', components: [0.2, 0.4, 0.6] })).toMatchObject({
      direct: true,
      writeSpace: 'srgb',
    });
    expect(pickerBinding({ colorSpace: 'display-p3', components: [0.2, 0.4, 0.6] }).direct).toBe(
      false,
    );
    expect(pickerBinding(oklch(0.6, 0.35, 150)).direct).toBe(false);
  });

  test('the picker and the numeric controls reach the same authored value', () => {
    const start = oklch(0.6, 0.1, 250);
    const binding = pickerBinding(start);
    const viaPicker = colorFromPicker(binding.value, 'oklch')!;
    expect(viaPicker.colorSpace).toBe('oklch');
    for (const [index, part] of viaPicker.components.entries()) {
      expect(Number(part)).toBeCloseTo(Number(start.components[index]), 2);
    }
    const viaChannel = withChannel(start, 0, 0.6);
    const viaText = parseColorText('oklch(0.6 0.1 250)');
    expect(viaText.ok && viaText.color).toEqual(viaChannel);
    const picked = colorFromPicker('oklch(60% 0.1 250)', 'oklch');
    expect(picked).toEqual(viaChannel);
  });

  test('an sRGB source stays sRGB through the picker and alpha is kept', () => {
    const picked = colorFromPicker('oklch(0.6 0.15 250 / 0.4)', 'srgb')!;
    expect(picked.colorSpace).toBe('srgb');
    expect(picked.alpha).toBe(0.4);
    expect(picked.components.every((part) => typeof part === 'number')).toBe(true);
  });

  test('a conversion is explicit and the source is never rewritten', () => {
    const p3: DtcgColor = { colorSpace: 'display-p3', components: [1, 0, 0] };
    expect(gamutInfo(p3)).toEqual({ srgb: false, displayP3: true });
    const asOklch = convertTo(p3, 'oklch')!;
    expect(asOklch.colorSpace).toBe('oklch');
    expect(p3).toEqual({ colorSpace: 'display-p3', components: [1, 0, 0] });
    expect(authoredOklch(p3).c).toBeGreaterThan(0.29);
  });

  test('light and dark are read independently and the background follows the pairing', async () => {
    const workbench = new ThemeWorkbenchState();
    const controller = new ThemeBuilderController({ workbench, evaluator, persistence: null });
    await controller.start();
    const envelope = controller.draft!.envelope;
    const modes = colorsByMode(envelope, 'text.default');
    expect(modes.light?.components[0]).toBe(0.2);
    expect(modes.dark?.components[0]).toBe(0.92);
    const row = catalogueRowByPath('text.default')!;
    const background = effectiveBackground(row, envelope, workbench.context);
    expect(background?.path).toBe('surface.base');
  });
});

describe('the color-filtered catalogue', () => {
  test('?filter=color lists every color token across all groups', () => {
    const filters = filtersFromSearch('?filter=color');
    expect(filters.color).toBe(true);
    const rows = rowsForView('foundations', filters);
    expect(rows.length).toBe(catalogueRows.filter((row) => row.type === 'color').length);
    expect(rows.every((row) => row.type === 'color')).toBe(true);
    expect(new Set(rows.map((row) => row.group)).size).toBeGreaterThan(1);
    expect(filtersFromSearch('?filter=other').color).toBe(false);
    expect(filtersFromSearch('').color).toBe(false);
  });
});
