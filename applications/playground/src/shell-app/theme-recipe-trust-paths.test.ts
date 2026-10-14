/**
 * Every playground path that turns a draft into runtime sources must make untrusted recipes
 * inert. COR-486 moved `buildThemeSources` into the runtime while COR-488 guarded it in the
 * playground; this pins the merged result so the CSS export, the portable export and the
 * runtime evaluator never see an imported recipe.
 */

import { describe, expect, test } from 'bun:test';

import { cinderThemeBase } from './theme-builder-base.ts';
import { createDraft } from './theme-draft.ts';
import { createEnvelope } from './theme-envelope.ts';
import { planPortable } from './theme-export-portable.ts';
import { takeExportSnapshot } from './theme-export-snapshot.ts';
import { trustedThemeSources } from './theme-recipe-trust.ts';
import { createRuntimeEvaluator } from './theme-runtime-evaluator.ts';

const HOSTILE = 'red; background: url(x)';

function importedEnvelope() {
  const blank = createEnvelope('imported', 'Imported', cinderThemeBase());
  const light = {
    border: {
      ink: {
        $type: 'color',
        $value: { colorSpace: 'srgb', components: [1, 0, 0] },
        $extensions: { 'com.lostgradient.cinder': { cssRecipe: HOSTILE, trusted: true } },
      },
    },
  };
  return { ...blank, overrides: { ...blank.overrides, light } };
}

const envelope = importedEnvelope();
const snapshot = await takeExportSnapshot(createDraft(envelope), createRuntimeEvaluator());

describe('untrusted recipes stay inert on every source path', () => {
  test('the runtime sources omit the recipe while the envelope keeps it', () => {
    expect(JSON.stringify(trustedThemeSources(envelope, 0).documents)).not.toContain('url(x)');
    expect(JSON.stringify(envelope.overrides.light)).toContain('url(x)');
  });

  test('the export snapshot evaluates without the recipe in any context', () => {
    for (const evaluation of Object.values(snapshot.evaluations)) {
      expect(evaluation.ok).toBe(true);
      if (!evaluation.ok) continue;
      expect(Object.values(evaluation.properties).join(' ')).not.toContain('url(');
    }
  });

  test('the portable export never carries the recipe', () => {
    expect(JSON.stringify(planPortable(snapshot))).not.toContain(HOSTILE);
  });
});
