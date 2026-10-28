/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { flushSync, mount, tick, unmount } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

import { cinderThemeBase } from './theme-builder-base.ts';
import { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import { createEnvelope } from './theme-envelope.ts';
import { createRuntimeEvaluator } from './theme-runtime-evaluator.ts';
import ThemeScalePresets from './theme-scale-presets.svelte';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

setupHappyDom();

const evaluator = createRuntimeEvaluator();
await evaluator.evaluate(
  createEnvelope('warmup', 'Warm-up', cinderThemeBase()),
  0,
  'light/default',
);

async function controllerFor() {
  const workbench = new ThemeWorkbenchState();
  const controller = new ThemeBuilderController({ workbench, evaluator, persistence: null });
  await controller.start();
  return { controller, workbench };
}

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
    // load-proof: the editors flush through Svelte and the in-memory evaluator, so the update settles inside the microtask queue
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
