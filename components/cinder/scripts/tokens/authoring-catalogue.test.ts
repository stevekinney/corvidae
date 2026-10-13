import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { TOKEN_REGISTRY } from '../../src/tokens/registry.generated.ts';
import { buildAuthoringCatalogue } from '../../src/tokens/runtime/authoring-catalogue.ts';
import type { AuthoringCatalogue } from '../../src/tokens/runtime/authoring-types.ts';
import { serializeAuthoringCatalogue } from './authoring-catalogue-output.ts';
import { cloneCorpus, loadProfileCorpus } from './authoring-test-support.ts';
import { loadCorpus } from './generate.ts';
import { authoringCataloguePath } from './generator-configuration.ts';

const SIX_CONTEXTS = [
  'light/default',
  'light/reduced',
  'light/forced-reduced-motion',
  'dark/default',
  'dark/reduced',
  'dark/forced-reduced-motion',
];

const BASE = 'profile-base.tokens.json';

type MutableGroup = Record<string, any>;

function baseDocument(corpus: ReturnType<typeof cloneCorpus>): MutableGroup {
  return corpus.documentsByPath.get(BASE) as MutableGroup;
}

function publicToken(cssProperty: string, category: string, extra: Record<string, unknown> = {}) {
  return {
    $type: 'dimension',
    $value: { value: 1, unit: 'rem' },
    $extensions: {
      'com.lostgradient.cinder': { cssProperty, public: true, category, ...extra },
    },
  };
}

describe('the real catalogue', async () => {
  const corpus = await loadCorpus();
  const catalogue = buildAuthoringCatalogue(corpus.resolver, corpus.documentsByPath);

  test('has exactly one record per public registry entry', () => {
    const publicEntries = TOKEN_REGISTRY.entries.filter((entry) => entry.public);
    expect(publicEntries.length).toBeGreaterThan(0);
    expect(catalogue.records).toHaveLength(publicEntries.length);
    expect(catalogue.records.map((record) => record.path)).toEqual(
      publicEntries.map((entry) => entry.path),
    );
    expect(new Set(catalogue.records.map((record) => record.path)).size).toBe(
      catalogue.records.length,
    );
    expect(new Set(catalogue.records.map((record) => record.cssProperty)).size).toBe(
      new Set(publicEntries.map((entry) => entry.cssProperty)).size,
    );
  });

  test('never lists a private runtime variable', () => {
    for (const record of catalogue.records) {
      expect(record.cssProperty.startsWith('--cinder-')).toBe(true);
      expect(record.cssProperty).not.toMatch(/^--_cinder-/);
    }
  });

  test('covers all six contexts for every token exactly once', () => {
    expect(catalogue.contexts.map((context) => context.id)).toEqual(SIX_CONTEXTS);
    for (const record of catalogue.records) {
      const covered = record.variants.flatMap((variant) => variant.contexts).toSorted();
      expect(covered).toEqual([...SIX_CONTEXTS].toSorted());
      for (const variant of record.variants) {
        expect(variant.provenance.layers.length).toBeGreaterThan(0);
        expect(variant.provenance.winner.document).toMatch(/\.tokens\.json$/);
      }
    }
  });

  test('the committed artifact is the generator output', async () => {
    const committed = readFileSync(authoringCataloguePath, 'utf8');
    expect(committed).toBe(await serializeAuthoringCatalogue(catalogue));
  });

  test('assigns every record a defined profile and reports unknown, never an invented value', () => {
    for (const record of catalogue.records) {
      expect(catalogue.profiles[record.profile]).toBeDefined();
      expect(record.category).not.toBe('');
      if (record.palette) expect(record.palette).toEqual({ family: 'unknown', anchor: 'unknown' });
    }
    const colors = catalogue.records.filter((record) => record.profile === 'color');
    expect(colors.length).toBeGreaterThan(0);
    expect(colors.every((record) => record.palette !== undefined)).toBe(true);
  });

  test('spacing scale membership is the public literal dimension members of the space group', () => {
    const foundation = JSON.parse(
      readFileSync(
        new URL('../../src/tokens/sets/foundation.tokens.json', import.meta.url),
        'utf8',
      ),
    ) as { space: Record<string, any> };
    const literalMembers = Object.entries(foundation.space)
      .filter(([name, member]) => !name.startsWith('$') && typeof member.$value === 'object')
      .map(([name]) => `space.${name}`);
    expect(literalMembers).toHaveLength(19);
    expect(catalogue.scales['spacing']!.toSorted()).toEqual(literalMembers.toSorted());
    expect(new Set(catalogue.scales['spacing']).size).toBe(19);
    // `space.one` is `--cinder-space-1`: membership is not inferred from a name prefix.
    expect(catalogue.scales['spacing']).toContain('space.one');
    const scaled = catalogue.records.filter((record) => record.scale !== undefined);
    expect(scaled.map((record) => record.path).toSorted()).toEqual(literalMembers.toSorted());
    for (const record of catalogue.records) {
      if (/^(radius|font|motion|leading|tracking)\./.test(record.path)) {
        expect(record.scale).toBeUndefined();
      }
    }
  });

  test('the four CSS-only tokens carry explicit status and no value', () => {
    const cssOnly = catalogue.records.filter((record) => record.disposition.edit === 'css-only');
    expect(cssOnly.map((record) => record.path).toSorted()).toEqual([
      'carousel.aspect-ratio',
      'carousel.slide-size',
      'code-block.height',
      'spinner.indicator',
    ]);
    for (const record of cssOnly) {
      expect(record.disposition.dtcgExport).toBe('none');
      expect(record.disposition.cssExport).toBe('supported');
      expect(record.disposition.cssValue).toBeString();
      expect(JSON.stringify(record)).not.toContain('"$value"');
      expect(JSON.stringify(record)).not.toContain('"value"');
    }
  });

  test('every other token is exported at least as a DTCG value', () => {
    for (const record of catalogue.records) {
      if (record.disposition.edit !== 'css-only') {
        expect(record.disposition.dtcgExport).not.toBe('none');
        expect(record.disposition.cssValue).toBeUndefined();
      }
    }
  });
});

describe('the catalogue over a fixture corpus', () => {
  test('lists the public tokens and leaves out unbound and private ones', () => {
    const corpus = cloneCorpus(loadProfileCorpus());
    baseDocument(corpus)['internal'] = {
      scratch: publicToken('--_cinder-scratch', 'size', { public: false }),
    };
    const catalogue = buildAuthoringCatalogue(corpus.resolver, corpus.documentsByPath);
    const paths = catalogue.records.map((record) => record.path);
    expect(paths).not.toContain('internal.scratch');
    expect(paths).not.toContain('imported.brand');
    expect(paths).toContain('palette.halo');
    expect(catalogue.records.every((record) => !record.cssProperty.startsWith('--_cinder-'))).toBe(
      true,
    );
  });

  test('a new public token appears with no manual step', () => {
    const before = buildAuthoringCatalogue(
      loadProfileCorpus().resolver,
      loadProfileCorpus().documentsByPath,
    );
    const corpus = cloneCorpus(loadProfileCorpus());
    baseDocument(corpus)['badge'] = { gap: publicToken('--cinder-badge-gap', 'spacing') };
    const after = buildAuthoringCatalogue(corpus.resolver, corpus.documentsByPath);
    expect(after.records).toHaveLength(before.records.length + 1);
    const added = after.records.find((record) => record.path === 'badge.gap')!;
    expect(added.profile).toBe('gap');
    expect(added.variants.flatMap((variant) => variant.contexts)).toHaveLength(6);
  });

  test('a new public token that no usage rule covers fails generation', () => {
    const corpus = cloneCorpus(loadProfileCorpus());
    baseDocument(corpus)['weird'] = { thing: publicToken('--cinder-weird-thing', 'spacing') };
    expect(() => buildAuthoringCatalogue(corpus.resolver, corpus.documentsByPath)).toThrow(
      'Token "weird.thing" (type dimension, category spacing) has no CSS usage profile',
    );
  });

  test('missing source metadata is rendered as unknown', () => {
    const corpus = cloneCorpus(loadProfileCorpus());
    baseDocument(corpus)['plain'] = {
      swatch: {
        $type: 'color',
        $value: { colorSpace: 'srgb', components: [0, 0, 0] },
        $extensions: {
          'com.lostgradient.cinder': { cssProperty: '--cinder-plain-swatch', public: true },
        },
      },
    };
    const record = buildAuthoringCatalogue(corpus.resolver, corpus.documentsByPath).records.find(
      (candidate) => candidate.path === 'plain.swatch',
    )!;
    expect(record.category).toBe('unknown');
    expect(record.description).toBe('unknown');
    expect(record.component).toBeNull();
    expect(record.palette).toEqual({ family: 'unknown', anchor: 'unknown' });
  });

  test('the fixture catalogue records its scale, layers, and recipes', () => {
    const corpus = loadProfileCorpus();
    const catalogue: AuthoringCatalogue = buildAuthoringCatalogue(
      corpus.resolver,
      corpus.documentsByPath,
    );
    expect(catalogue.scales).toEqual({ spacing: ['space.one', 'space.two'] });
    expect(
      catalogue.layerStacks['dark/forced-reduced-motion']!.map((layer) => layer.layer),
    ).toEqual(['sets.foundation', 'theme.dark', 'motion.forced-reduced-motion']);
    const halo = catalogue.records.find((record) => record.path === 'palette.halo')!;
    expect(halo.disposition.cssSerialization).toBe('mixed');
    expect(halo.disposition.dtcgExport).toBe('subset');
  });
});

describe('spacing scale validation', () => {
  function build(edit: (base: MutableGroup) => void) {
    const corpus = cloneCorpus(loadProfileCorpus());
    edit(baseDocument(corpus));
    return () => buildAuthoringCatalogue(corpus.resolver, corpus.documentsByPath);
  }

  test('rejects a scale member that is not in the group', () => {
    const run = build((base) => {
      base['motion'].fast.$extensions['com.lostgradient.cinder'].scale = 'spacing';
    });
    expect(run).toThrow(
      'Scale "spacing" member "motion.fast" is not a public literal dimension in group "space".',
    );
  });

  test('rejects a scale member that is an alias rather than a literal', () => {
    const run = build((base) => {
      base['space'].two.$value = '{space.one}';
    });
    expect(run).toThrow('member "space.two" is not a public literal dimension');
  });

  test('rejects a scale member that is not public', () => {
    const run = build((base) => {
      base['space'].two.$extensions['com.lostgradient.cinder'].public = false;
      base['space'].two.$extensions['com.lostgradient.cinder'].cssProperty = '--_cinder-space-2';
    });
    expect(run).toThrow('member "space.two" is not a public literal dimension');
  });

  test('rejects a public literal dimension in the group that lacks the metadata', () => {
    const run = build((base) => {
      delete base['space'].two.$extensions['com.lostgradient.cinder'].scale;
    });
    expect(run).toThrow(
      'Public literal dimension "space.two" in group "space" lacks scale "spacing" metadata.',
    );
  });

  test('rejects a scale member whose CSS usage profile is missing', () => {
    const run = build((base) => {
      base['space'].two.$extensions['com.lostgradient.cinder'].category = 'layout';
    });
    expect(run).toThrow(
      'Token "space.two" (type dimension, category layout) has no CSS usage profile',
    );
  });

  test('rejects an unknown scale name', () => {
    const run = build((base) => {
      base['space'].two.$extensions['com.lostgradient.cinder'].scale = 'colour';
    });
    expect(run).toThrow('declares unknown scale "colour"');
  });

  test('a radius token is never a scale member unless it is marked', () => {
    const corpus = cloneCorpus(loadProfileCorpus());
    baseDocument(corpus)['radius'] = {
      $type: 'dimension',
      small: publicToken('--cinder-radius-small', 'radius'),
    };
    const catalogue = buildAuthoringCatalogue(corpus.resolver, corpus.documentsByPath);
    expect(catalogue.scales['spacing']).toEqual(['space.one', 'space.two']);
    expect(
      catalogue.records.find((record) => record.path === 'radius.small')!.scale,
    ).toBeUndefined();
  });
});

describe('CSS-only disposition', () => {
  test('a CSS-only token with no recipe is rejected', () => {
    const corpus = cloneCorpus(loadProfileCorpus());
    baseDocument(corpus)['carousel'] = {
      'slide-size': {
        $type: 'number',
        $value: 100,
        $extensions: {
          'com.lostgradient.cinder': {
            cssProperty: '--cinder-carousel-slide-size',
            public: true,
            category: 'layout',
            nonRepresentableValue: true,
          },
        },
      },
    };
    expect(() => buildAuthoringCatalogue(corpus.resolver, corpus.documentsByPath)).toThrow(
      'CSS-only token "carousel.slide-size" carries no cssRecipe, so it has no CSS value.',
    );
  });

  test('a token that is css-only in one context and portable in another is rejected', () => {
    const corpus = cloneCorpus(loadProfileCorpus());
    baseDocument(corpus)['carousel'] = {
      'aspect-ratio': {
        $type: 'number',
        $value: 1.7778,
        $extensions: {
          'com.lostgradient.cinder': {
            cssProperty: '--cinder-carousel-aspect-ratio',
            public: true,
            category: 'layout',
            nonRepresentableValue: true,
            cssRecipe: '16 / 9',
          },
        },
      },
    };
    (corpus.documentsByPath.get('profile-dark.tokens.json') as MutableGroup)['carousel'] = {
      'aspect-ratio': { $value: 2 },
    };
    // The dark override restates no flag, and the flag is not inherited.
    expect(() => buildAuthoringCatalogue(corpus.resolver, corpus.documentsByPath)).toThrow(
      'css-only in some contexts and portable in others',
    );
  });
});
