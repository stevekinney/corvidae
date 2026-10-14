/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { flushSync, mount, tick, unmount } from 'svelte';

import { AUTHORING_CATALOGUE } from '@lostgradient/cinder/tokens/runtime';
import { setupHappyDom } from '@lostgradient/testing';

import { cinderThemeBase } from './theme-builder-base.ts';
import { catalogueRowByPath } from './theme-builder-catalogue.ts';
import { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import { editableState, type JsonObject, type ThemeEnvelope } from './theme-draft-types.ts';
import { createEnvelope } from './theme-envelope.ts';
import { createRuntimeEvaluator } from './theme-runtime-evaluator.ts';
import ThemeScalePresets from './theme-scale-presets.svelte';
import {
  activePreset,
  applyProposal,
  baseDimension,
  buildProposal,
  parseMultiplier,
  proposalIsStale,
  SCALE_PRESETS,
  scaleDimension,
  scaleMembers,
  type Proposal,
} from './theme-scale-presets.ts';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

setupHappyDom();

const evaluator = createRuntimeEvaluator();
await evaluator.evaluate(
  createEnvelope('warmup', 'Warm-up', cinderThemeBase()),
  0,
  'light/default',
);

const light = { colorMode: 'light', motion: 'default' } as const;
const dark = { colorMode: 'dark', motion: 'default' } as const;
const fresh = (): ThemeEnvelope => createEnvelope('presets', 'Presets', cinderThemeBase());

function proposal(
  factor: number,
  scale = 'spacing',
  envelope = fresh(),
  scope = 'shared' as const,
) {
  return buildProposal({ envelope, draftRevision: 1, context: light, scope, scale, factor });
}

async function controllerFor() {
  const workbench = new ThemeWorkbenchState();
  const controller = new ThemeBuilderController({ workbench, evaluator, persistence: null });
  await controller.start();
  return { controller, workbench };
}

const css = (controller: ThemeBuilderController, path: string) =>
  controller.draftValues.get(catalogueRowByPath(path)!.cssProperty);

async function applyFor(
  controller: ThemeBuilderController,
  built: Proposal,
  selected = built.rows.filter((row) => row.selectedByDefault).map((row) => row.path),
) {
  return controller.commit({
    kind: 'edit',
    label: 'Apply preset',
    state: applyProposal(controller.draft!.envelope, built, selected),
  });
}

describe('scale membership', () => {
  test('spacing and radius members come from explicit catalogue metadata', () => {
    const marked = (scale: string) =>
      AUTHORING_CATALOGUE.records.filter((record) => record.scale === scale).map((r) => r.path);
    expect(scaleMembers('spacing')).toHaveLength(19);
    expect(scaleMembers('radius')).toEqual([
      'radius.small',
      'radius.medium',
      'radius.large',
      'radius.full',
    ]);
    for (const scale of ['spacing', 'radius']) {
      expect(marked(scale).toSorted()).toEqual([...scaleMembers(scale)].toSorted());
    }
    // Aliases in the radius group follow their members; they are skipped, never members.
    expect(scaleMembers('radius')).not.toContain('radius.control');
    expect(proposal(1, 'radius').skipped.map((entry) => entry.path)).toContain('radius.control');
  });
});

describe('the factors', () => {
  test.each(SCALE_PRESETS)(
    '$label ($factor) scales every member and keeps its unit',
    ({ factor, id }) => {
      for (const scale of ['spacing', 'radius']) {
        const built = proposal(factor, scale);
        expect(built.presetId).toBe(id);
        expect(built.rows.map((row) => row.path)).toEqual(scaleMembers(scale).slice());
        for (const row of built.rows) {
          expect(row.proposed.unit).toBe(row.base.unit);
          expect(row.proposed.value).toBeCloseTo(row.base.value * factor, 5);
        }
      }
    },
  );

  test('zero stays zero, rem stays rem, px stays px, and Standard is base-equivalent', () => {
    const spacing = proposal(0.75);
    expect(spacing.rows.find((row) => row.path === 'space.0')!.proposed).toEqual({
      value: 0,
      unit: 'rem',
    });
    expect(spacing.rows.find((row) => row.path === 'space.one')!.proposed).toEqual({
      value: 0.1875,
      unit: 'rem',
    });
    const radius = proposal(1.25, 'radius');
    expect(radius.rows.find((row) => row.path === 'radius.full')!.proposed).toEqual({
      value: 12498.75,
      unit: 'px',
    });
    for (const row of proposal(1).rows) expect(row.proposed).toEqual(row.base);
    expect(scaleDimension({ value: 0.1, unit: 'rem' }, 3)).toEqual({ value: 0.3, unit: 'rem' });
  });

  test('a multiplier is finite from 0 to 4', () => {
    for (const ok of ['0', '4', '0.75', '1.25', ' 2 '])
      expect(parseMultiplier(ok)).toMatchObject({ ok: true });
    for (const bad of ['', '-0.1', '4.01', 'NaN', 'Infinity', '1e999', 'two', '1,5']) {
      expect(parseMultiplier(bad)).toMatchObject({ ok: false });
    }
    expect(proposal(0).rows.every((row) => row.proposed.value === 0)).toBe(true);
    expect(proposal(4).presetId).toBeNull();
  });

  test('the base value for a scope comes from the base alone, never from an override', async () => {
    const { controller } = await controllerFor();
    await controller.commit({
      kind: 'edit',
      label: 'override',
      edit: {
        kind: 'set-override',
        scope: 'shared',
        path: 'space.one',
        node: { $type: 'dimension', $value: { value: 9, unit: 'px' } },
      },
    });
    const envelope = controller.draft!.envelope;
    expect(baseDimension(envelope, 'shared', light, 'space.one')).toEqual({
      value: 0.25,
      unit: 'rem',
    });
    expect(baseDimension(envelope, 'dark', dark, 'space.one')).toEqual({
      value: 0.25,
      unit: 'rem',
    });
  });
});

describe('applying a proposal', () => {
  test('is one undoable transaction that undo restores exactly', async () => {
    const { controller } = await controllerFor();
    const before = editableState(controller.draft!.envelope);
    const built = proposal(1.25);
    const outcome = await applyFor(controller, built);
    expect(outcome).toEqual({ ok: true, changed: true });
    expect(controller.history!.entries).toHaveLength(1);
    expect(css(controller, 'space.4')).toBe('1.25rem');
    expect(css(controller, 'space.0')).toBe('0');
    await controller.undo();
    expect(editableState(controller.draft!.envelope)).toEqual(before);
    expect(css(controller, 'space.4')).toBe('1rem');
    await controller.redo();
    expect(css(controller, 'space.4')).toBe('1.25rem');
  });

  test('reapplying the same proposal to the same base and scope is a no-op with no history entry', async () => {
    const { controller } = await controllerFor();
    await applyFor(controller, proposal(0.75));
    const entries = controller.history!.entries.length;
    const revision = controller.draft!.revision;
    const again = buildProposal({
      envelope: controller.draft!.envelope,
      draftRevision: revision,
      context: light,
      scope: 'shared',
      scale: 'spacing',
      factor: 0.75,
    });
    expect(again.rows.every((row) => row.status === 'applied')).toBe(true);
    expect(await applyFor(controller, again)).toEqual({ ok: true, changed: false });
    expect(controller.history!.entries).toHaveLength(entries);
    expect(controller.draft!.revision).toBe(revision);
  });

  test('Standard writes base-equivalent values and does not remove other overrides', async () => {
    const { controller } = await controllerFor();
    await controller.commit({
      kind: 'edit',
      label: 'other',
      edit: {
        kind: 'set-override',
        scope: 'shared',
        path: 'opacity.disabled',
        node: { $type: 'number', $value: 0.3 },
      },
    });
    const built = buildProposal({
      envelope: controller.draft!.envelope,
      draftRevision: controller.draft!.revision,
      context: light,
      scope: 'shared',
      scale: 'spacing',
      factor: 1,
    });
    await applyFor(controller, built);
    const written = controller.draft!.envelope.overrides.shared;
    expect(written['opacity']).toBeDefined();
    expect((written['space'] as JsonObject)['one']).toEqual({
      $type: 'dimension',
      $value: { value: 0.25, unit: 'rem' },
    });
    expect(css(controller, 'space.one')).toBe('0.25rem');
  });

  test('a partial selection writes only the chosen rows and is not a named preset', async () => {
    const { controller } = await controllerFor();
    await applyFor(controller, proposal(1.25), ['space.4', 'space.8']);
    const space = controller.draft!.envelope.overrides.shared['space'] as JsonObject;
    expect(Object.keys(space).toSorted()).toEqual(['4', '8']);
    const envelope = controller.draft!.envelope;
    expect(activePreset(envelope, light, 'shared', 'spacing')).toBeNull();
    await applyFor(
      controller,
      buildProposal({
        envelope,
        draftRevision: 2,
        context: light,
        scope: 'shared',
        scale: 'spacing',
        factor: 1.25,
      }),
    );
    expect(activePreset(controller.draft!.envelope, light, 'shared', 'spacing')).toBe(
      'comfortable',
    );
    expect(activePreset(controller.draft!.envelope, light, 'shared', 'radius')).toBeNull();
  });

  test('a locked member is listed, cannot be selected, and is never written', async () => {
    const { controller } = await controllerFor();
    await controller.setLocked('space.4', true);
    const built = buildProposal({
      envelope: controller.draft!.envelope,
      draftRevision: controller.draft!.revision,
      context: light,
      scope: 'shared',
      scale: 'spacing',
      factor: 0.75,
    });
    const row = built.rows.find((entry) => entry.path === 'space.4')!;
    expect(row).toMatchObject({ status: 'locked', selectable: false, selectedByDefault: false });
    await applyFor(
      controller,
      built,
      built.rows.map((entry) => entry.path),
    );
    expect(css(controller, 'space.4')).toBe('1rem');
    expect(css(controller, 'space.8')).toBe('1.5rem');
  });

  test('an existing explicit override is replaced only when its row is selected, and keeps its metadata', async () => {
    const { controller } = await controllerFor();
    await controller.commit({
      kind: 'edit',
      label: 'override',
      edit: {
        kind: 'set-override',
        scope: 'shared',
        path: 'space.3',
        node: { $type: 'dimension', $value: { value: 9, unit: 'px' }, $description: 'Mine' },
      },
    });
    const make = () =>
      buildProposal({
        envelope: controller.draft!.envelope,
        draftRevision: controller.draft!.revision,
        context: light,
        scope: 'shared',
        scale: 'spacing',
        factor: 0.75,
      });
    const row = make().rows.find((entry) => entry.path === 'space.3')!;
    expect(row).toMatchObject({ status: 'overridden', selectable: true, selectedByDefault: false });
    expect(row.existing).toEqual({ value: 9, unit: 'px' });
    await applyFor(controller, make());
    expect(css(controller, 'space.3')).toBe('9px');
    await applyFor(controller, make(), ['space.3']);
    expect(css(controller, 'space.3')).toBe('0.5625rem');
    const node = (controller.draft!.envelope.overrides.shared['space'] as JsonObject)['3'];
    expect(node).toMatchObject({ $description: 'Mine' });
  });

  test('aliases and recipes are reported as dependents and never written or detached', async () => {
    const { controller } = await controllerFor();
    const built = proposal(0.75);
    expect(built.dependents.aliases).toContain('gap.stack');
    expect(built.dependents.aliases).toContain('overlay.padding');
    const before = new Map(controller.draftValues);
    await applyFor(controller, built);
    const written = new Set(built.rows.map((row) => catalogueRowByPath(row.path)!.cssProperty));
    const followers = new Set(
      [...built.dependents.aliases, ...built.dependents.recipes].map(
        (path) => catalogueRowByPath(path)!.cssProperty,
      ),
    );
    for (const [property, value] of controller.draftValues) {
      if (before.get(property) !== value)
        expect(written.has(property) || followers.has(property)).toBe(true);
    }
    expect(css(controller, 'gap.stack')).toBe('var(--cinder-space-3)');
    expect(controller.draft!.envelope.overrides.shared).not.toHaveProperty('gap');
  });

  test('never shrinks an unrelated fixed hit-target token', async () => {
    const { controller } = await controllerFor();
    const rows = proposal(0.75).rows.map((row) => row.path);
    for (const fixed of [
      'touch.target-min',
      'control.height.xs',
      'control.height.sm',
      'control.height.lg',
    ]) {
      expect(rows).not.toContain(fixed);
    }
    const before = ['touch.target-min', 'control.height.sm'].map((path) => css(controller, path));
    await applyFor(controller, proposal(0.75));
    expect(['touch.target-min', 'control.height.sm'].map((path) => css(controller, path))).toEqual(
      before,
    );
  });

  test('a scoped proposal stays in its scope and leaves other contexts alone', async () => {
    const { controller } = await controllerFor();
    const built = proposal(1.25, 'radius', controller.draft!.envelope, 'shared');
    const darkOnly = buildProposal({
      envelope: controller.draft!.envelope,
      draftRevision: 1,
      context: dark,
      scope: 'dark',
      scale: 'radius',
      factor: 1.25,
    });
    expect(built.scope).toBe('shared');
    expect(darkOnly.scope).toBe('dark');
    await applyFor(controller, darkOnly);
    expect(controller.draft!.envelope.overrides.shared).toEqual({});
    expect(controller.draft!.envelope.overrides.light).toEqual({});
    expect(controller.draft!.envelope.overrides.dark).toHaveProperty('radius');
    await controller.switchContext(dark);
    expect(css(controller, 'radius.medium')).toBe('0.625rem');
    await controller.switchContext(light);
    expect(css(controller, 'radius.medium')).toBe('0.5rem');
  });

  test('later layers that keep overriding a member are reported', async () => {
    const { controller } = await controllerFor();
    await controller.commit({
      kind: 'edit',
      label: 'dark override',
      edit: {
        kind: 'set-override',
        scope: 'dark',
        path: 'space.4',
        node: { $type: 'dimension', $value: { value: 3, unit: 'rem' } },
      },
    });
    const built = buildProposal({
      envelope: controller.draft!.envelope,
      draftRevision: 2,
      context: dark,
      scope: 'shared',
      scale: 'spacing',
      factor: 1.25,
    });
    expect(built.rows.find((row) => row.path === 'space.4')!.laterLayers).toEqual(['dark']);
    expect(built.rows.find((row) => row.path === 'space.2')!.laterLayers).toEqual([]);
  });
});

describe('a stale proposal', () => {
  test('is stale once the base, revision, context or scope changes', () => {
    const envelope = fresh();
    const built = proposal(1.25, 'spacing', envelope);
    expect(proposalIsStale(built, envelope, 1, light, 'shared')).toBe(false);
    expect(proposalIsStale(built, envelope, 2, light, 'shared')).toBe(true);
    expect(proposalIsStale(built, envelope, 1, dark, 'shared')).toBe(true);
    expect(proposalIsStale(built, envelope, 1, light, 'light')).toBe(true);
    const other = { ...envelope, base: { ...envelope.base, sourceDigest: 'sha256:other' } };
    expect(proposalIsStale(built, other, 1, light, 'shared')).toBe(true);
  });
});

describe('the preset controls', () => {
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    await tick();
  };
  const button = (label: string) =>
    [...target.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label,
    )!;
  async function open() {
    const { controller, workbench } = await controllerFor();
    mounted = mount(ThemeScalePresets, {
      target,
      props: { controller, workbench, scale: 'spacing', label: 'Spacing' },
    });
    await settle();
    return { controller, workbench };
  }

  test('a proposal shows scope, every value, dependents and skipped; Cancel changes nothing', async () => {
    const { controller } = await open();
    button('Comfortable (1.25)').click();
    await settle();
    const region = target.querySelector('[data-testid="proposal-spacing"]')!;
    expect(region.textContent).toContain('Shared (all modes)');
    expect(region.querySelectorAll('tbody tr')).toHaveLength(19);
    expect(region.textContent).toContain('1.25rem');
    expect(
      target.querySelector('[data-testid="proposal-spacing-dependents"]')?.textContent,
    ).toContain('gap.stack');
    expect(controller.history!.entries).toHaveLength(0);
    button('Cancel').click();
    await settle();
    expect(target.querySelector('[data-testid="proposal-spacing"]')).toBeNull();
    expect(controller.history!.entries).toHaveLength(0);
    expect(controller.draft!.envelope.overrides.shared).toEqual({});
  });

  test('Apply is one undoable transaction, reapplying says so, and a stale proposal cannot apply', async () => {
    const { controller } = await open();
    button('Compact (0.75)').click();
    await settle();
    button('Apply proposal').click();
    await settle();
    expect(controller.history!.entries).toHaveLength(1);
    expect(target.querySelector('[data-testid="presets-spacing-active"]')?.textContent).toContain(
      'Compact',
    );
    button('Compact (0.75)').click();
    await settle();
    button('Apply proposal').click();
    await settle();
    expect(controller.history!.entries).toHaveLength(1);
    expect(target.querySelector('[data-testid="presets-spacing-result"]')?.textContent).toContain(
      'No change',
    );

    button('Comfortable (1.25)').click();
    await settle();
    await controller.setLocked('space.4', true);
    await settle();
    expect(target.querySelector('[data-testid="proposal-spacing-stale"]')).not.toBeNull();
    expect(button('Apply proposal').disabled).toBe(true);
    expect(controller.history!.entries).toHaveLength(2);
  });

  test('locked rows have a disabled checkbox and overridden rows start unselected', async () => {
    const { controller } = await open();
    await controller.setLocked('space.4', true);
    await controller.commit({
      kind: 'edit',
      label: 'override',
      edit: {
        kind: 'set-override',
        scope: 'shared',
        path: 'space.3',
        node: { $type: 'dimension', $value: { value: 9, unit: 'px' } },
      },
    });
    button('Compact (0.75)').click();
    await settle();
    const box = (path: string) =>
      target.querySelector<HTMLInputElement>(`tr[data-path="${path}"] input[type="checkbox"]`)!;
    expect(box('space.4').disabled).toBe(true);
    expect(box('space.4').checked).toBe(false);
    expect(box('space.3').disabled).toBe(false);
    expect(box('space.3').checked).toBe(false);
    expect(box('space.2').checked).toBe(true);
    expect(box('space.2').labels?.[0]?.textContent ?? '').toContain('space.2');
  });

  test('an invalid custom multiplier is refused in the field', async () => {
    await open();
    const field = target.querySelector<HTMLInputElement>('input[id$="-custom"]')!;
    field.value = '5';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    button('Preview multiplier').click();
    await settle();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(target.querySelector('[data-testid="proposal-spacing"]')).toBeNull();
  });
});
