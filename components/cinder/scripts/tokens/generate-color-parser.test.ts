import { describe, expect, test } from 'bun:test';
import { assertResolutionOrderMatchesCssBlockStructure } from '../../src/tokens/runtime/css-support.ts';
import type { ResolverDocument } from '../../src/tokens/runtime/types.ts';
function resolverWithOrder(refs: string[]): ResolverDocument {
  return {
    version: '2025.10',
    sets: { foundation: { sources: [{ $ref: 'base.json' }] } },
    modifiers: {
      theme: { contexts: { light: [{ $ref: 'theme.json' }] }, default: 'light' },
      motion: { contexts: { default: [{ $ref: 'motion.json' }] }, default: 'default' },
    },
    resolutionOrder: refs.map((ref) => ({ $ref: ref })),
  };
}

describe('CIN-469 finding 5: resolutionOrder is validated against the fixed CSS block structure', () => {
  test('the corpus resolutionOrder (foundation, theme, motion) passes', () => {
    const resolver = resolverWithOrder([
      '#/sets/foundation',
      '#/modifiers/theme',
      '#/modifiers/motion',
    ]);
    expect(() => assertResolutionOrderMatchesCssBlockStructure(resolver)).not.toThrow();
  });

  test('motion before theme is rejected -- tokens-base.css always emits theme blocks first', () => {
    const resolver = resolverWithOrder([
      '#/sets/foundation',
      '#/modifiers/motion',
      '#/modifiers/theme',
    ]);
    expect(() => assertResolutionOrderMatchesCssBlockStructure(resolver)).toThrow(
      /"motion" before "theme"/,
    );
  });

  test('a modifier before a set is rejected -- :root always assembles every "sets" entry unconditionally', () => {
    const resolver = resolverWithOrder([
      '#/modifiers/theme',
      '#/sets/foundation',
      '#/modifiers/motion',
    ]);
    expect(() => assertResolutionOrderMatchesCssBlockStructure(resolver)).toThrow(
      /interleaves a "sets" entry after a "modifiers" entry/,
    );
  });

  test('a third modifier is rejected -- the override-block template only knows how to emit theme and motion', () => {
    // `buildTokensBaseCss` hardcodes `theme`/`motion` for CSS emission, but
    // `modifierValuesForCombo`'s default-fill would still bake a third
    // modifier's default-context documents into every resolved-context
    // snapshot -- so a schema-valid resolver adding one would make the
    // published snapshots disagree with the generated CSS for every
    // combination, not just a specific value collision.
    const resolver: ResolverDocument = {
      version: '2025.10',
      sets: { foundation: { sources: [{ $ref: 'base.json' }] } },
      modifiers: {
        theme: { contexts: { light: [{ $ref: 'theme.json' }] }, default: 'light' },
        motion: { contexts: { default: [{ $ref: 'motion.json' }] }, default: 'default' },
        density: { contexts: { comfortable: [{ $ref: 'density.json' }] }, default: 'comfortable' },
      },
      resolutionOrder: [
        { $ref: '#/sets/foundation' },
        { $ref: '#/modifiers/theme' },
        { $ref: '#/modifiers/motion' },
        { $ref: '#/modifiers/density' },
      ],
    };
    expect(() => assertResolutionOrderMatchesCssBlockStructure(resolver)).toThrow(
      /declares modifier\(s\) "density".*only knows how to emit "theme" and "motion"/,
    );
  });
});
