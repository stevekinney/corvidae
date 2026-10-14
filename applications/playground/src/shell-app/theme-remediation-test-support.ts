/**
 * Test-only fixtures for the remediation suites (COR-487): a content-keyed memoizing
 * evaluator (so a proposal, its Apply-time recomputation and the report all reuse one
 * runtime evaluation of the same source), the shipped and failing envelopes, and a helper
 * that finds one finding in a report.
 */

import { cinderThemeBase } from './theme-builder-base.ts';
import { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import type { ReportRecord } from './theme-check-types.ts';
import type { ThemeEvaluation, ThemeEvaluator } from './theme-draft-evaluation.ts';
import type { JsonValue, ThemeContextId, ThemeEnvelope } from './theme-draft-types.ts';
import { createEnvelope } from './theme-envelope.ts';
import { setNode } from './theme-override-tree.ts';
import { reportForEnvelope } from './theme-remediation-check.ts';
import { createRuntimeEvaluator } from './theme-runtime-evaluator.ts';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

const real = createRuntimeEvaluator();
const remembered = new Map<string, Promise<ThemeEvaluation>>();

/** The real runtime evaluator, remembered by the content of the editable state. */
export const memoEvaluator: ThemeEvaluator = {
  evaluate(source, revision, context: ThemeContextId) {
    const key = JSON.stringify([source.overrides, source.cssOverrides, context]);
    const known = remembered.get(key);
    if (known !== undefined) return known.then((value) => ({ ...value, revision }));
    const pending = real.evaluate(source, revision, context);
    remembered.set(key, pending);
    return pending;
  },
};

export const shippedEnvelope = createEnvelope('shipped', 'Cinder default', cinderThemeBase());

export const oklchColor = (l: number, c: number, h: number, alpha?: number): JsonValue => ({
  $type: 'color',
  $value: {
    colorSpace: 'oklch',
    components: [l, c, h],
    ...(alpha === undefined ? {} : { alpha }),
  },
});

/** The shipped theme with one token overridden in one scope. */
export function withOverride(
  scope: 'shared' | 'light' | 'dark',
  path: string,
  node: JsonValue,
  base: ThemeEnvelope = shippedEnvelope,
): ThemeEnvelope {
  return {
    ...base,
    overrides: { ...base.overrides, [scope]: setNode(base.overrides[scope], path, node) },
  };
}

/** Light text so pale it fails the 4.5:1 text threshold on every light surface. */
export const dimmedText = withOverride('light', 'text.default', oklchColor(0.93, 0.01, 245));

export async function findFinding(
  envelope: ThemeEnvelope,
  predicate: (record: ReportRecord) => boolean,
): Promise<ReportRecord> {
  const { report } = await reportForEnvelope(memoEvaluator, envelope, 1);
  const all = [...report.records.wcag, ...report.records.advisory, ...report.records.cinderProfile];
  const found = all.find((record) => record.severity !== null && predicate(record));
  if (found === undefined) throw new Error('The fixture produced no matching finding.');
  return found;
}

export const textOnCanvas = (record: ReportRecord): boolean =>
  record.pairingId === 'text:default:canvas' && record.context === 'light/default';

/** A controller over the real runtime with the given envelope's state committed as revision 2. */
export async function openController(
  envelope: ThemeEnvelope = shippedEnvelope,
  evaluator: ThemeEvaluator = memoEvaluator,
): Promise<{ controller: ThemeBuilderController; workbench: ThemeWorkbenchState }> {
  const workbench = new ThemeWorkbenchState();
  const controller = new ThemeBuilderController({
    workbench,
    evaluator,
    persistence: null,
    newId: () => 'shipped',
    now: () => '2026-10-14T00:00:00.000Z',
  });
  await controller.start();
  if (envelope !== shippedEnvelope) {
    const outcome = await controller.commit({
      kind: 'edit',
      label: 'Set up the fixture',
      state: { overrides: envelope.overrides, cssOverrides: envelope.cssOverrides },
    });
    if (!outcome.ok) throw new Error(outcome.message);
  }
  return { controller, workbench };
}
