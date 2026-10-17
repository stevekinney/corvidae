/**
 * A `color-mix(in oklch, …)` interpolates hue around the wheel. Between two
 * hues far apart that path passes through colors neither operand has: a
 * green status tone mixed toward the cool h245 neutrals landed on cyan, an
 * amber one on olive. Mixing a tone with a neutral belongs in `oklab`, which
 * interpolates in a straight line and keeps the tone's own hue.
 *
 * Every derived recipe is evaluated in both themes, and any OKLCH mix whose
 * operands' hues differ by more than 40° fails unless the token carries a
 * `hueTravel` reason in its `com.lostgradient.cinder` extension. A missing hue
 * (`none`, or `transparent`) has nothing to travel from and is not counted.
 */

import { expect, test } from 'bun:test';

import { cinderExtensions } from '../../src/tokens/runtime/corpus.ts';
import { collectDerivedTokens, recipeFor, themeLookup, THEMES } from './derived-values.ts';
import { loadCorpus } from './generate.ts';
import { evaluateRecipe } from './recipe-evaluator.ts';

const MAX_HUE_TRAVEL = 40;

function hueDistance(first: number, second: number): number {
  const delta = Math.abs(first - second) % 360;
  return delta > 180 ? 360 - delta : delta;
}

test('no OKLCH mix travels more than 40° of hue without a reason', async () => {
  const { resolver, documentsByPath } = await loadCorpus();
  const { derived, pathByProperty } = collectDerivedTokens(resolver, documentsByPath);
  const offenders: string[] = [];
  let mixes = 0;
  for (const theme of THEMES) {
    const lookup = themeLookup(resolver, documentsByPath, pathByProperty, theme);
    for (const token of derived) {
      const document = documentsByPath.get(token.documentPath)!;
      const source = token.keys.reduce<unknown>(
        (node, key) => (node as Record<string, unknown>)[key],
        document,
      ) as Parameters<typeof cinderExtensions>[0];
      const reason = cinderExtensions(source)?.['hueTravel'];
      evaluateRecipe(recipeFor(token, theme), lookup, (space, first, second) => {
        if (space !== 'oklch') return;
        mixes += 1;
        if (first.h === undefined || second.h === undefined) return;
        const distance = hueDistance(first.h, second.h);
        if (distance > MAX_HUE_TRAVEL && typeof reason !== 'string') {
          offenders.push(`${token.path} (${theme}): ${distance.toFixed(1)}° between operands`);
        }
      });
    }
  }
  expect(mixes, 'the check must actually see OKLCH mixes').toBeGreaterThan(0);
  expect(offenders, offenders.join('\n')).toEqual([]);
});
