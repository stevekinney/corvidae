/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { flushSync, mount, tick, unmount } from 'svelte';

import { buildThemeSources, evaluateThemeProperties } from '@lostgradient/cinder/tokens/runtime';
import { setupHappyDom } from '@lostgradient/testing';

import { cinderThemeBase } from './theme-builder-base.ts';
import { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import { evaluator } from './theme-builder-test-support.ts';
import { createEnvelope } from './theme-envelope.ts';
import ThemePalettePanel from './theme-palette-panel.svelte';
import {
  applyPaletteState,
  buildPaletteProposal,
  PALETTE_FAMILY_OPTIONS,
} from './theme-palette-proposal.ts';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

setupHappyDom();

// Every family's proposal, applied to both modes, must be a theme the real runtime accepts.
const applied = PALETTE_FAMILY_OPTIONS.map((option) => {
  const envelope = createEnvelope('t', 'T', cinderThemeBase());
  const result = buildPaletteProposal({
    seed: 'oklch(0.62 0.19 260)',
    family: option.id,
    gamut: 'srgb',
    envelope,
    locked: new Set(),
  });
  if (!result.ok) throw new Error(result.message);
  const state = applyPaletteState(envelope, result.proposal, {
    modes: new Set(['light', 'dark']),
    includeOverrides: new Set(),
  });
  const sources = buildThemeSources({ ...envelope, overrides: state.overrides }, 1);
  return { family: option.id, evaluation: evaluateThemeProperties(sources) };
});

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

const settle = async () => {
  // load-proof: the editors flush through Svelte and the in-memory evaluator, so the update settles inside the microtask queue
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
  await tick();
};

async function open() {
  const workbench = new ThemeWorkbenchState();
  const controller = new ThemeBuilderController({ workbench, evaluator, persistence: null });
  await controller.start();
  let closed = 0;
  mounted = mount(ThemePalettePanel, {
    target,
    props: { controller, workbench, onClose: () => (closed += 1) },
  });
  await settle();
  return { controller, workbench, closed: () => closed };
}

async function type(id: string, value: string): Promise<void> {
  const input = target.querySelector<HTMLInputElement>(`[id="${id}"]`)!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
}

async function toggle(id: string): Promise<void> {
  target.querySelector<HTMLInputElement>(`[id="${id}"]`)!.click();
  await settle();
}

const button = (label: string) =>
  [...target.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
async function press(label: string): Promise<void> {
  button(label)!.click();
  await settle();
}
const proposed = (mode: 'light' | 'dark') =>
  [
    ...target.querySelectorAll(
      `[data-testid="palette-roles-${mode}"] [data-testid="palette-proposed"]`,
    ),
  ].map((node) => node.textContent);

describe('every family applies cleanly', () => {
  test.each(applied)('the $family proposal is a theme the runtime accepts', ({ evaluation }) => {
    expect(evaluation.ok).toBe(true);
  });
});

describe('the Create palette panel', () => {
  test('shows nothing until a seed is given, then both modes separately, labeled OKLCH', async () => {
    await open();
    expect(target.querySelector('[data-testid="palette-roles-light"]')).toBeNull();
    await type('palette-seed', '#0ea5e9');
    expect(proposed('light')).toEqual([
      'oklch(0.68469 0.14787 237.322)',
      'oklch(0.61469 0.13419 237.322)',
    ]);
    expect(proposed('dark')).toHaveLength(2);
    expect(target.textContent).toContain('Original (oklch)');
    expect(target.textContent).toContain('Proposed (OKLCH)');
    expect(target.textContent).toContain('does not check or assert accessibility');
  });

  test('an invalid seed is reported on the field and proposes nothing', async () => {
    await open();
    await type('palette-seed', 'not a color');
    expect(target.querySelector('[id="palette-seed"]')!.getAttribute('aria-invalid')).toBe('true');
    expect(target.querySelector('[data-testid="palette-roles-light"]')).toBeNull();
  });

  test('Apply commits the selected modes as one undoable transaction, and undo restores it', async () => {
    const { controller, closed } = await open();
    await type('palette-seed', '#0ea5e9');
    await toggle('palette-apply-dark');
    expect(
      target.querySelector('[data-testid="palette-count"]')!.textContent?.replaceAll(/\s+/g, ' '),
    ).toContain('2 roles will change');
    const before = controller.draft!.envelope.overrides;
    await press('Apply palette');
    expect(controller.history!.entries).toHaveLength(1);
    expect(controller.history!.entries[0]!.label).toBe('Apply Accent palette (light)');
    expect(controller.draft!.envelope.overrides.dark).toEqual({});
    expect(Object.keys(controller.draft!.envelope.overrides.light)).toEqual(['accent']);
    expect(controller.announcement).toContain('Accessibility checks have not been run');
    expect(closed()).toBe(1);
    await controller.undo();
    expect(controller.draft!.envelope.overrides).toEqual(before);
  });

  test('locked roles are preserved and not written', async () => {
    const { controller } = await open();
    await type('palette-seed', '#0ea5e9');
    await toggle('palette-lock-light:accent.solid');
    // The lock is a committed, undoable transaction; the proposal rebuilds from its revision.
    await settle();
    expect(controller.lockedPaths.has('accent.solid')).toBe(true);
    await press('Apply palette');
    expect(controller.draft!.envelope.locked).toEqual(['accent.solid']);
    const light = controller.draft!.envelope.overrides.light as { accent: Record<string, unknown> };
    expect(Object.keys(light.accent)).toEqual(['text']);
    const dark = controller.draft!.envelope.overrides.dark as { accent: Record<string, unknown> };
    expect(Object.keys(dark.accent)).toEqual(['text']);
  });

  test('an existing override is listed and replaced only when explicitly included', async () => {
    const { controller } = await open();
    await controller.commit({
      kind: 'edit',
      label: 'existing',
      edit: {
        kind: 'set-override',
        scope: 'light',
        path: 'accent.text.$root',
        node: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 0, 0] } },
      },
    });
    await type('palette-seed', '#0ea5e9');
    expect(target.textContent).toContain('Existing overrides');
    expect(target.textContent).toContain('Replace the existing override of accent.text');
    await press('Apply palette');
    const light = controller.draft!.envelope.overrides.light as {
      accent: { text: { $root: { $value: unknown } } };
    };
    expect(light.accent.text.$root.$value).toEqual({ colorSpace: 'srgb', components: [1, 0, 0] });
  });

  test('Cancel discards the proposal without touching the draft', async () => {
    const { controller, closed } = await open();
    await type('palette-seed', '#0ea5e9');
    await press('Cancel');
    expect(closed()).toBe(1);
    expect(controller.history!.entries).toHaveLength(0);
    expect(controller.draft!.envelope.overrides.light).toEqual({});
  });

  test('previews the proposal in the preview frame before Apply, and ends the preview on Cancel', async () => {
    const { workbench } = await open();
    await type('palette-seed', '#0ea5e9');
    await settle();
    expect(workbench.proposalPreview).toBe(true);
    await press('Cancel');
    await settle();
    expect(workbench.proposalPreview).toBe(false);
  });

  test('offers Components and Application previews', async () => {
    const { workbench } = await open();
    await type('palette-seed', '#0ea5e9');
    await press('Preview Application');
    expect(workbench.sceneId.startsWith('application/')).toBe(true);
    await press('Preview Components');
    expect(workbench.sceneId.startsWith('components/')).toBe(true);
  });
});
