/// <reference lib="dom" />
/**
 * Test-only harness shared by the reference, recipe and disclosure suites (COR-488): a mount
 * target per test, a controller seeded with the fixture Source tokens, and the small DOM
 * helpers those suites use. Runtime evaluation is remembered by the content of the editable
 * state (COR-1572), so a test that starts a controller over a state some earlier test, or the
 * suite's module-scope `warmStates`, already visited replays it from memory instead of running
 * the token runtime again. Cold evaluation happens at module scope in each suite, outside any
 * test's time budget.
 */

import { CINDER_BASE } from '@lostgradient/cinder/tokens/runtime';
import { afterEach, beforeEach, expect } from 'bun:test';
import { flushSync, mount, tick, unmount, type Component } from 'svelte';

import { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import type { ThemeEvaluation, ThemeEvaluator } from './theme-draft-evaluation.ts';
import { editableState, type JsonObject } from './theme-draft-types.ts';
import { fixtureDraft, SOURCE_TOKENS } from './theme-reference-fixtures.ts';
import { createRuntimeEvaluator } from './theme-runtime-evaluator.ts';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

/**
 * Replayed results are shared between tests, so they are frozen: the consumers treat them as
 * read-only (`ThemeEvaluation` is `readonly`, and the controller copies the properties it keeps),
 * and a test that mutated one would throw instead of leaking state into a later test.
 */
function freezeEvaluation(evaluation: ThemeEvaluation): ThemeEvaluation {
  const members = evaluation.ok ? evaluation.properties : evaluation.diagnostics;
  for (const member of members) Object.freeze(member);
  Object.freeze(members);
  return Object.freeze(evaluation);
}

/**
 * An evaluator that remembers the real one by everything an evaluation reads: the base's source
 * digest, the overrides, the CSS-only overrides, and the context (COR-1572). The runtime is
 * deterministic in those inputs, and the evaluator it wraps remembers only per envelope object,
 * which every controller start and commit makes anew. Only the revision differs between equal
 * states, so it is stamped on the replayed result.
 *
 * The digest stands for the base's resolver and documents only when they are the ones this
 * build of Cinder ships, so an envelope whose base is not `CINDER_BASE`'s is never remembered:
 * it goes to the real evaluator every time.
 */
export function createMemoEvaluator(
  real: ThemeEvaluator = createRuntimeEvaluator(),
): ThemeEvaluator {
  const remembered = new Map<string, Promise<ThemeEvaluation>>();
  return {
    evaluate(source, revision, context) {
      const { base } = source;
      if (base.documents !== CINDER_BASE.documents || base.resolver !== CINDER_BASE.resolver) {
        return real.evaluate(source, revision, context);
      }
      const key = JSON.stringify([
        base.sourceDigest,
        source.overrides,
        source.cssOverrides,
        context,
      ]);
      const known = remembered.get(key);
      if (known !== undefined) return known.then((value) => ({ ...value, revision }));
      const pending = real.evaluate(source, revision, context).then(freezeEvaluation);
      remembered.set(key, pending);
      return pending;
    },
  };
}

export const memoEvaluator: ThemeEvaluator = createMemoEvaluator();

/** The fixture tokens with `extra` members added under `fx`. */
export function overlayTokens(extra: JsonObject): JsonObject {
  return { ...SOURCE_TOKENS, fx: { ...(SOURCE_TOKENS['fx'] as JsonObject), ...extra } };
}

export const PROBE_TOKENS = overlayTokens({ probe: { $type: 'dimension', $value: '{fx.c}' } });

/**
 * Evaluate, once and outside any test's budget, the states `start` seeds for each of `sources`.
 * Await it at module scope with every Source-token set the suite starts a controller over.
 */
export async function warmStates(...sources: JsonObject[]): Promise<void> {
  for (const source of sources) {
    const workbench = new ThemeWorkbenchState();
    const controller = new ThemeBuilderController({
      workbench,
      evaluator: memoEvaluator,
      persistence: null,
    });
    await controller.start();
    await controller.commit({
      kind: 'edit',
      label: 'Seed',
      state: editableState(fixtureDraft(source, 'mounted').envelope),
    });
    controller.stop();
  }
}

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
      const controller = new ThemeBuilderController({
        workbench,
        evaluator: memoEvaluator,
        persistence: null,
      });
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
