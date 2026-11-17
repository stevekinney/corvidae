import { describe, expect, test } from 'bun:test';

import { buildAuthoringCatalogue } from '../../src/tokens/runtime/authoring-catalogue.ts';
import { PALETTE_FAMILIES } from '../../src/tokens/runtime/authoring-types.ts';
import { cloneCorpus, loadProfileCorpus } from './authoring-test-support.ts';
import { loadCorpus } from './generate.ts';

type MutableGroup = Record<string, any>;

function colorToken(cssProperty: string, palette?: unknown) {
  return {
    $type: 'color',
    $value: { colorSpace: 'oklch', components: [0.5, 0.1, 250] },
    $extensions: {
      'com.lostgradient.cinder': {
        cssProperty,
        public: true,
        category: 'color',
        ...(palette === undefined ? {} : { palette }),
      },
    },
  };
}

function build(edit: (base: MutableGroup) => void) {
  const corpus = cloneCorpus(loadProfileCorpus());
  edit(corpus.documentsByPath.get('profile-base.tokens.json') as MutableGroup);
  return () => buildAuthoringCatalogue(corpus.resolver, corpus.documentsByPath);
}

describe('palette metadata in the real catalogue', async () => {
  const corpus = await loadCorpus();
  const catalogue = buildAuthoringCatalogue(corpus.resolver, corpus.documentsByPath);
  const members = catalogue.records.filter(
    (record) => record.palette !== undefined && record.palette.family !== 'unknown',
  );

  test('every family has exactly one anchor and unique roles', () => {
    const families = new Set(members.map((record) => record.palette!.family));
    expect([...families].toSorted()).toEqual([...PALETTE_FAMILIES].toSorted());
    for (const family of families) {
      const inFamily = members.filter((record) => record.palette!.family === family);
      expect(inFamily.filter((record) => record.palette!.anchor === true)).toHaveLength(1);
      expect(new Set(inFamily.map((record) => record.palette!.role)).size).toBe(inFamily.length);
    }
  });

  test('the anchors are the solid fills and the default text ink', () => {
    const anchors = members
      .filter((record) => record.palette!.anchor === true)
      .map((record) => `${record.palette!.family}:${record.path}`)
      .toSorted();
    expect(anchors).toEqual([
      'accent:accent.solid',
      'danger:status.danger.solid',
      'info:status.info.solid',
      'neutral:text.default',
      'success:status.success.solid',
      'warning:status.warning.solid',
    ]);
  });

  test('membership is explicit: undeclared colors stay unknown', () => {
    const chart = catalogue.records.find((record) => record.path === 'chart.series.1')!;
    expect(chart.palette).toEqual({ family: 'unknown', role: 'unknown', anchor: 'unknown' });
  });
});

describe('palette metadata validation', () => {
  test('a valid family with one anchor builds', () => {
    const run = build((base) => {
      base['halo'] = {
        one: colorToken('--cinder-halo-one', { family: 'accent', role: 'one', anchor: true }),
        two: colorToken('--cinder-halo-two', { family: 'accent', role: 'two' }),
      };
    });
    const records = run().records.filter((record) => record.path.startsWith('halo.'));
    expect(records.map((record) => record.palette)).toEqual([
      { family: 'accent', role: 'one', anchor: true },
      { family: 'accent', role: 'two', anchor: false },
    ]);
  });

  test('rejects a family with no anchor', () => {
    const run = build((base) => {
      base['halo'] = { one: colorToken('--cinder-halo-one', { family: 'accent', role: 'one' }) };
    });
    expect(run).toThrow('Palette family "accent" has no anchor.');
  });

  test('rejects more than one anchor in a family', () => {
    const run = build((base) => {
      base['halo'] = {
        one: colorToken('--cinder-halo-one', { family: 'info', role: 'one', anchor: true }),
        two: colorToken('--cinder-halo-two', { family: 'info', role: 'two', anchor: true }),
      };
    });
    expect(run).toThrow('Palette family "info" has more than one anchor: halo.one, halo.two.');
  });

  test('rejects a repeated role, an unknown family, and a bad shape', () => {
    expect(
      build((base) => {
        base['halo'] = {
          one: colorToken('--cinder-halo-one', { family: 'info', role: 'r', anchor: true }),
          two: colorToken('--cinder-halo-two', { family: 'info', role: 'r' }),
        };
      }),
    ).toThrow('repeats the role "r"');
    expect(
      build((base) => {
        base['halo'] = { one: colorToken('--cinder-halo-one', { family: 'brand', role: 'r' }) };
      }),
    ).toThrow('unknown palette family "brand"');
    expect(
      build((base) => {
        base['halo'] = {
          one: colorToken('--cinder-halo-one', { family: 'info', role: 'r', extra: 1 }),
        };
      }),
    ).toThrow('palette declares unknown "extra"');
    expect(
      build((base) => {
        base['halo'] = { one: colorToken('--cinder-halo-one', { family: 'info', role: '' }) };
      }),
    ).toThrow('needs a non-empty role');
  });

  test('rejects a palette on a token that is not a color', () => {
    const run = build((base) => {
      base['space']['two']['$extensions']['com.lostgradient.cinder'].palette = {
        family: 'accent',
        role: 'x',
        anchor: true,
      };
    });
    expect(run).toThrow('declares a palette but is not a color');
  });

  test('rejects different memberships in different contexts', () => {
    const corpus = cloneCorpus(loadProfileCorpus());
    const base = corpus.documentsByPath.get('profile-base.tokens.json') as MutableGroup;
    base['halo'] = {
      one: colorToken('--cinder-halo-one', { family: 'info', role: 'r', anchor: true }),
    };
    const dark = corpus.documentsByPath.get('profile-dark.tokens.json') as MutableGroup;
    dark['halo'] = {
      one: {
        $value: { colorSpace: 'oklch', components: [0.6, 0.1, 250] },
        $extensions: {
          'com.lostgradient.cinder': { palette: { family: 'info', role: 'other', anchor: true } },
        },
      },
    };
    expect(() => buildAuthoringCatalogue(corpus.resolver, corpus.documentsByPath)).toThrow(
      'declares a different palette in different contexts',
    );
  });
});
