/// <reference lib="dom" />
/**
 * DOM tests for the checks panel (COR-259): scoped wording, stale results never reading as a
 * pass, one aggregate announcement per committed change, no focus movement on background
 * revalidation, and findings that select the exact editor and preview state.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { flushSync, mount, tick, unmount } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

import { awakeTurns } from '@lostgradient/testing/wait-until';
import { cinderThemeBase } from './theme-builder-base.ts';
import { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import ThemeChecksPanel from './theme-checks-panel.svelte';
import type { ThemeEvaluation, ThemeEvaluator } from './theme-draft-evaluation.ts';
import { THEME_CONTEXT_IDS, type ThemeContextId, type ThemeEnvelope } from './theme-draft-types.ts';
import { createEnvelope } from './theme-envelope.ts';
import { setNode } from './theme-override-tree.ts';
import { createRuntimeEvaluator } from './theme-runtime-evaluator.ts';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

setupHappyDom();

const DIMMED_TEXT = {
  $type: 'color',
  $value: { colorSpace: 'oklch', components: [0.93, 0.01, 245] },
};

// The runtime work happens once, at module scope; the evaluator below replays it.
const real = createRuntimeEvaluator();
const shipped = createEnvelope('shipped', 'Cinder default', cinderThemeBase());
const dimmed: ThemeEnvelope = {
  ...shipped,
  overrides: {
    ...shipped.overrides,
    light: setNode(shipped.overrides.light, 'text.default', DIMMED_TEXT),
  },
};
const precomputed = new Map<string, ThemeEvaluation>();
for (const [name, envelope] of [
  ['shipped', shipped],
  ['dimmed', dimmed],
] as const) {
  for (const context of THEME_CONTEXT_IDS) {
    precomputed.set(`${name}:${context}`, await real.evaluate(envelope, 1, context));
  }
}
const replay: ThemeEvaluator = {
  async evaluate(source, revision, context: ThemeContextId) {
    const edited = (source.overrides.light as { text?: unknown }).text !== undefined;
    return {
      ...precomputed.get(`${edited ? 'dimmed' : 'shipped'}:${context}`)!,
      revision,
      context,
    };
  },
};

let target: HTMLElement;
let mounted: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(() => {
  if (mounted !== null) void unmount(mounted);
  mounted = null;
  target.remove();
});

async function until(condition: () => boolean): Promise<void> {
  for await (const _ of awakeTurns()) {
    if (condition()) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
    flushSync();
    await tick();
  }
  if (!condition()) throw new Error('The panel never reached the expected state.');
}

async function open() {
  const workbench = new ThemeWorkbenchState();
  const controller = new ThemeBuilderController({
    workbench,
    evaluator: replay,
    persistence: null,
    newId: () => 'shipped',
    now: () => '2026-10-13T00:00:00.000Z',
  });
  await controller.start();
  mounted = mount(ThemeChecksPanel, {
    target,
    props: { workbench, controller, evaluator: replay },
  });
  flushSync();
  const panel = () => target.querySelector<HTMLElement>('[data-testid="checks-panel"]')!;
  await until(() => panel().dataset['readiness'] === 'ready');
  return { workbench, controller, panel };
}

const edit = {
  kind: 'edit' as const,
  label: 'Dim the light text',
  edit: {
    kind: 'set-override' as const,
    scope: 'light' as const,
    path: 'text.default',
    node: DIMMED_TEXT,
  },
};

describe('the checks panel', () => {
  test('uses scoped wording and never claims the theme is accessible or certified', async () => {
    const { panel, workbench } = await open();
    const text = panel().textContent ?? '';
    expect(text).toContain('scoped check');
    expect(text).toContain('Revision');
    expect(text).not.toMatch(/\bWCAG[- ]certified\b/i);
    expect(text).not.toMatch(/\baccessible\b/i);
    expect(workbench.exportReadiness).toBe('ready');
    expect(workbench.findingsCount).toBe(0);
    expect(
      target.querySelector('[data-testid="count-accessibility-error"]')?.textContent,
    ).toContain('0');
  });

  test('a committed edit makes the old result stale at once, then replaces it', async () => {
    const { panel, controller, workbench } = await open();
    await controller.commit(edit);
    flushSync();
    // Before the new report lands the old Pass must not be showing.
    expect(panel().dataset['readiness']).not.toBe('ready');
    expect(workbench.exportReadiness).not.toBe('ready');
    await until(() => panel().dataset['readiness'] === 'blocked-accessibility-errors');
    expect(workbench.exportReadiness).toBe('blocked-accessibility-errors');
    expect(workbench.findingsCount).toBeGreaterThan(0);
    expect(target.querySelectorAll('[data-testid="finding"]').length).toBeGreaterThan(0);
  });

  test('announces the aggregate once, and revalidation never moves focus', async () => {
    const { controller } = await open();
    const outside = document.createElement('button');
    outside.textContent = 'Somewhere else';
    document.body.append(outside);
    outside.focus();
    const announcer = () =>
      target.querySelector('[data-testid="checks-announcer"]')?.textContent?.trim() ?? '';
    expect(announcer()).toBe('');
    await controller.commit(edit);
    await until(() => announcer() !== '');
    expect(announcer()).toMatch(/^Checks for revision \d+: \d+ accessibility errors?, /);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  test('a finding selects its token, context and scene in the workbench', async () => {
    const { controller, workbench } = await open();
    await controller.commit(edit);
    await until(
      () =>
        target.querySelectorAll('[data-testid="finding"][data-severity="accessibility-error"]')
          .length > 0,
    );
    const finding = target.querySelector<HTMLElement>(
      '[data-testid="finding"][data-severity="accessibility-error"]',
    )!;
    const button = [...finding.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Show in editor'),
    )!;
    button.click();
    flushSync();
    expect(workbench.selectedTokenPath).toBe('text.default');
    expect(workbench.context.colorMode).toBe('light');
    expect(workbench.sceneId).not.toBe('');
  });
});
