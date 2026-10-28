/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { flushSync, mount, tick, unmount } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

import { quietFor } from '@lostgradient/testing/wait-until';
import { cinderThemeBase } from './theme-builder-base.ts';
import { catalogueRowByPath } from './theme-builder-catalogue.ts';
import { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import type { ThemeEvaluator } from './theme-draft-evaluation.ts';
import { createEnvelope } from './theme-envelope.ts';
import FoundationEditor from './theme-foundation-editor.svelte';
import { createRuntimeEvaluator } from './theme-runtime-evaluator.ts';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

setupHappyDom();

const real = createRuntimeEvaluator();
await real.evaluate(createEnvelope('warmup', 'Warm-up', cinderThemeBase()), 0, 'light/default');

// Evaluation takes real time, as it does in the browser under load.
const slow: ThemeEvaluator = {
  evaluate: async (source, revision, context) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return real.evaluate(source, revision, context);
  },
};

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

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(): Promise<void> {
  // load-proof: the editors flush through Svelte and the in-memory evaluator, so the update settles inside the microtask queue
  await pause(0);
  flushSync();
  await tick();
}

async function openOpacity(evaluator: ThemeEvaluator) {
  const workbench = new ThemeWorkbenchState();
  const controller = new ThemeBuilderController({ workbench, evaluator, persistence: null });
  await controller.start();
  const row = catalogueRowByPath('opacity.disabled')!;
  mounted = mount(FoundationEditor, { target, props: { controller, workbench, row } });
  await settle();
  return { controller, row };
}

const entries = (controller: ThemeBuilderController) => controller.history!.entries.length;

describe('a slider gesture', () => {
  test('is one transaction with a numeric twin, when each commit lands before the next key', async () => {
    const { controller, row } = await openOpacity(real);
    expect(target.querySelector('input[id$="-amount"]')).not.toBeNull();
    const thumb = target.querySelector<HTMLElement>('[role="slider"]')!;
    expect(thumb.getAttribute('aria-label') ?? thumb.getAttribute('aria-labelledby')).toBeTruthy();
    const wrapper = thumb.closest<HTMLElement>('.scalar__slider')!;
    wrapper.dispatchEvent(new Event('pointerdown', { bubbles: false }));
    for (let step = 0; step < 2; step += 1) {
      thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      await settle();
    }
    wrapper.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
    await settle();
    expect(entries(controller)).toBe(1);
    expect(controller.draftValues.get(row.cssProperty)).toBe('0.53');
    expect(target.querySelector<HTMLInputElement>('input[id$="-amount"]')!.value).toBe('0.53');
    await controller.undo();
    expect(controller.draft!.envelope.overrides.shared).toEqual({});
  });

  test('ends only after its last commit lands, even when evaluation is slow', async () => {
    const { controller } = await openOpacity(slow);
    const thumb = target.querySelector<HTMLElement>('[role="slider"]')!;
    const wrapper = thumb.closest<HTMLElement>('.scalar__slider')!;
    // The key is released while its commit is still evaluating, as under load.
    wrapper.dispatchEvent(new Event('pointerdown', { bubbles: false }));
    thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    wrapper.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
    for (let wait = 0; wait < 150 && entries(controller) === 0; wait += 1) await pause(20);
    // Give a misplaced end every chance to land after the commit.
    await quietFor(100);
    await settle();
    expect(entries(controller)).toBe(1);
    expect(controller.history!.gesture).toBeNull();
    // The next ordinary edit appends its own entry instead of replacing the gesture's.
    await controller.commit({
      kind: 'edit',
      label: 'other',
      edit: {
        kind: 'set-override',
        scope: 'shared',
        path: 'opacity.faint',
        node: { $type: 'number', $value: 0.2 },
      },
    });
    expect(entries(controller)).toBe(2);
    expect(controller.draftValues.get(catalogueRowByPath('opacity.disabled')!.cssProperty)).toBe(
      '0.54',
    );
  });
});
