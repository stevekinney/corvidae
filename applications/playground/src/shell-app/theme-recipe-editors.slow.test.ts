/// <reference lib="dom" />
/**
 * The recipe-editor test that runs the full accessibility check pipeline over a proposal
 * (COR-1572). It keeps its name and body; only the lane changed, so it runs serially in
 * `test:slow` instead of beside three other workers when the host is loaded.
 */
import { describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

import { catalogueRowByPath } from './theme-builder-catalogue.ts';
import ThemeReferencePanel from './theme-reference-panel.svelte';
import { PROBE_TOKENS, useHarness, warmStates } from './theme-reference-test-support.ts';

setupHappyDom();
const h = useHarness();
const { settle, start, click, typeInto } = h;
// The state `start` seeds is evaluated here, outside any test's budget.
await warmStates(PROBE_TOKENS);

async function mountPanel(row: NonNullable<ReturnType<typeof catalogueRowByPath>>) {
  const { controller, workbench } = await start();
  h.mount(ThemeReferencePanel, { controller, workbench, row });
  await settle();
  return { controller, workbench };
}

describe('Check this change', () => {
  test('is offered inside the proposal, before Apply, and runs on request only', async () => {
    const { controller } = await mountPanel(catalogueRowByPath('surface.hover')!);
    await typeInto('-override', 'oklch(55% 0.2 270)');
    await click('Preview CSS override');
    expect(h.target.querySelector('[data-testid="checks-summary"]')).toBeNull();
    const revision = controller.draft!.revision;
    await click('Check this change');
    const summary = h.target.querySelector('[data-testid="checks-summary"]');
    expect(summary?.textContent).toContain('introduced');
    expect(
      h.target.querySelectorAll('[data-testid="impact-checks"] li[data-severity]'),
    ).toHaveLength(4);
    // Checking is read-only: the draft is untouched.
    expect(controller.draft!.revision).toBe(revision);
  });
});
