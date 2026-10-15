/// <reference lib="dom" />
/**
 * Test-only harness shared by the reference, recipe and disclosure suites (COR-488): a mount
 * target per test, a controller seeded with the fixture Source tokens, and the small DOM
 * helpers those suites use. Cold runtime evaluation happens at module scope in each suite,
 * outside any test's time budget.
 */

import { afterEach, beforeEach, expect } from 'bun:test';
import { flushSync, mount, tick, unmount, type Component } from 'svelte';

import { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import { editableState, type JsonObject } from './theme-draft-types.ts';
import { fixtureDraft, SOURCE_TOKENS } from './theme-reference-fixtures.ts';
import { createRuntimeEvaluator } from './theme-runtime-evaluator.ts';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

const evaluator = createRuntimeEvaluator();

/** The fixture tokens with `extra` members added under `fx`. */
export function overlayTokens(extra: JsonObject): JsonObject {
  return { ...SOURCE_TOKENS, fx: { ...(SOURCE_TOKENS['fx'] as JsonObject), ...extra } };
}

export const PROBE_TOKENS = overlayTokens({ probe: { $type: 'dimension', $value: '{fx.c}' } });

/** Install per-test mount handling; call once at the top level of a suite. */
export function useHarness() {
  let mounted: ReturnType<typeof mount> | null = null;
  let element: HTMLElement | null = null;

  beforeEach(() => {
    element = document.createElement('div');
    document.body.append(element);
  });

  afterEach(() => {
    if (mounted !== null) void unmount(mounted);
    mounted = null;
    element?.remove();
    element = null;
  });

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    await tick();
  }

  const harness = {
    get target(): HTMLElement {
      return element!;
    },
    settle,
    mount<Props extends Record<string, unknown>>(component: Component<Props>, props: Props): void {
      mounted = mount(component, { target: element!, props });
    },
    async start(source: JsonObject = PROBE_TOKENS) {
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
    },
    byLabel(label: string): HTMLButtonElement | undefined {
      return [...element!.querySelectorAll('button')].find(
        (candidate) =>
          candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label,
      );
    },
    async click(label: string): Promise<void> {
      const button = harness.byLabel(label);
      if (button === undefined) throw new Error(`No button “${label}”.`);
      button.click();
      await settle();
    },
    async typeInto(idSuffix: string, text: string): Promise<void> {
      const input = element!.querySelector<HTMLInputElement>(`input[id$="${idSuffix}"]`)!;
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await settle();
    },
  };
  return harness;
}
