/**
 * Test-only wiring for the import and export suites (COR-486): real runtime evaluator, an
 * edited envelope that exercises aliases, a Source token, a CSS-only edit and per-scope
 * overrides, and a controller over it.
 */

import { cinderThemeBase } from './theme-builder-base.ts';
import { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import type { ThemeEnvelope } from './theme-draft-types.ts';
import { applyEdit, createDraft, type DraftEdit } from './theme-draft.ts';
import { createEnvelope, envelopeDownload } from './theme-envelope.ts';
import { createRuntimeEvaluator } from './theme-runtime-evaluator.ts';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

export const evaluator = createRuntimeEvaluator();

const px = (value: number) => ({ $type: 'dimension', $value: { value, unit: 'px' } });

export const EDITS: DraftEdit[] = [
  { kind: 'set-override', scope: 'shared', path: 'radius.medium', node: px(5) },
  {
    kind: 'set-override',
    scope: 'shared',
    path: 'radius.small',
    node: { $type: 'dimension', $value: '{radius.medium}', $description: 'Follows medium.' },
  },
  { kind: 'set-override', scope: 'dark', path: 'radius.large', node: px(14) },
  {
    kind: 'set-override',
    scope: 'reduced',
    path: 'motion.fast',
    node: { $type: 'duration', $value: { value: 10, unit: 'ms' } },
  },
  {
    kind: 'set-override',
    scope: 'shared',
    path: 'specimen.accent',
    node: {
      $type: 'color',
      $value: { colorSpace: 'srgb', components: [0.2, 0.4, 0.6] },
      $extensions: { 'com.example.vendor': { keep: true } },
    },
  },
  { kind: 'set-css-override', path: 'carousel.slide-size', context: 'dark/default', value: '80%' },
];

/** An envelope with every kind of edit the exports have to carry. */
export function editedEnvelope(id = 'theme-aaaa-1111', name = 'Edited Theme'): ThemeEnvelope {
  let draft = createDraft(createEnvelope(id, name, cinderThemeBase()));
  for (const edit of EDITS) {
    const result = applyEdit(draft, edit);
    if (!result.ok) throw new Error(`test edit rejected: ${edit.kind}`);
    draft = result.draft;
  }
  return draft.envelope;
}

export const envelopeText = (envelope: ThemeEnvelope): string => envelopeDownload(envelope).text;

export async function openController(): Promise<ThemeBuilderController> {
  let counter = 0;
  const controller = new ThemeBuilderController({
    workbench: new ThemeWorkbenchState(),
    evaluator,
    persistence: null,
    newId: () => `generated-${(counter += 1)}`,
    now: () => '2026-10-14T00:00:00.000Z',
  });
  await controller.start();
  return controller;
}
