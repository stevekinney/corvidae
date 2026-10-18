/// <reference lib="dom" />
/**
 * The reference-editor tests that run the token runtime on states no other test visits
 * (COR-1572): each applies and undoes real proposals, so its cost is evaluation, not setup.
 * They keep their names and bodies; only the lane changed, so they run serially in `test:slow`
 * instead of beside three other workers when the host is loaded.
 */
import { describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import { type JsonObject } from './theme-draft-types.ts';
import { jsonEquals } from './theme-override-tree.ts';
import { proposeRebind } from './theme-reference-edits.ts';
import ThemeReferencePanel from './theme-reference-panel.svelte';
import {
  overlayTokens,
  PROBE_TOKENS,
  useHarness,
  warmStates,
} from './theme-reference-test-support.ts';
import { sourceTokenRow } from './theme-source-token-row.ts';
import { evaluatedThemeOf } from './theme-token-dependents.ts';

setupHappyDom();
const h = useHarness();
const { settle, start, byLabel, click, typeInto } = h;

const light = { colorMode: 'light', motion: 'default' } as const;
const rowOf = (path: string) => sourceTokenRow(path, 'dimension');

// The states the controller tests start over are evaluated here, outside any test's budget.
await warmStates(PROBE_TOKENS, overlayTokens({}));

describe('apply and undo through the controller', () => {
  test('one apply and one undo restore the value and the graph exactly', async () => {
    const { controller } = await start(overlayTokens({}));
    const row = rowOf('fx.b');
    const before = controller.draft!;
    const beforeGraph = JSON.stringify(
      [
        ...(evaluatedThemeOf(before.envelope).ok
          ? (evaluatedThemeOf(before.envelope) as never as { index: Map<string, unknown> }).index
          : []),
      ].map(([context, tokens]) => [
        context,
        [...(tokens as Map<string, { dependents: unknown }>)].map(([p, t]) => [p, t.dependents]),
      ]),
    );
    const proposal = proposeRebind(before, row, light, 'shared', 'fx.other');
    if (!proposal.ok) throw new Error(proposal.message);
    const entries = controller.history!.entries.length;
    const outcome = await controller.commit({
      kind: 'edit',
      label: 'Rebind fx.b',
      state: proposal.impact.state,
    });
    expect(outcome).toEqual({ ok: true, changed: true });
    expect(controller.history!.entries.length).toBe(entries + 1);
    expect(controller.draft!.revision).toBe(before.revision + 1);
    await controller.undo();
    expect(jsonEquals(controller.draft!.envelope.overrides, before.envelope.overrides)).toBe(true);
    const afterUndo = evaluatedThemeOf(controller.draft!.envelope);
    expect(afterUndo.ok).toBe(true);
    const graph = JSON.stringify(
      [...(afterUndo as never as { index: Map<string, unknown> }).index].map(
        ([context, tokens]) => [
          context,
          [...(tokens as Map<string, { dependents: unknown }>)].map(([p, t]) => [p, t.dependents]),
        ],
      ),
    );
    expect(graph).toBe(beforeGraph);
  });
});

const aliasRow = () => ({ ...rowOf('fx.b'), aliases: ['fx.a'], themeAware: true });
const lightFx = (controller: ThemeBuilderController) =>
  controller.draft!.envelope.overrides.light['fx'] as JsonObject | undefined;

async function mountPanel(row: ReturnType<typeof aliasRow>) {
  const { controller, workbench } = await start();
  h.mount(ThemeReferencePanel, { controller, workbench, row });
  await settle();
  return { controller, workbench };
}

describe('rebinding an alias', () => {
  test('Apply is one transaction and one Undo restores the draft exactly', async () => {
    const { controller } = await mountPanel(aliasRow());
    const before = controller.draft!.envelope.overrides;
    const entries = controller.history!.entries.length;
    await click('Rebind alias');
    await typeInto('-search', 'fx.oth');
    await click('Alias fx.b to fx.other');
    await click('Apply');
    expect(controller.history!.entries.length).toBe(entries + 1);
    expect((lightFx(controller)!['b'] as JsonObject)['$value']).toBe('{fx.other}');
    expect(controller.announcement).toContain('Rebind fx.b to fx.other');
    expect(h.target.querySelector('[data-testid="impact-list"]')).toBeNull();
    await controller.undo();
    expect(jsonEquals(controller.draft!.envelope.overrides, before)).toBe(true);
  });

  test('a proposal left open goes stale when the draft moves on, and cannot be applied', async () => {
    const { controller } = await mountPanel(aliasRow());
    await click('Rebind alias');
    await typeInto('-search', 'fx.oth');
    await click('Alias fx.b to fx.other');
    await controller.commit({
      kind: 'edit',
      label: 'Elsewhere',
      edit: {
        kind: 'set-override',
        scope: 'shared',
        path: 'fx.other',
        node: { $type: 'dimension', $value: { value: 9, unit: 'px' } },
      },
    });
    await settle();
    expect(h.target.querySelector('[data-testid="impact-stale"]')).not.toBeNull();
    expect(byLabel('Apply')!.hasAttribute('disabled')).toBe(true);
    const revision = controller.draft!.revision;
    await click('Cancel');
    expect(controller.draft!.revision).toBe(revision);
    expect(h.target.querySelector('[data-testid="impact-list"]')).toBeNull();
  });
});
