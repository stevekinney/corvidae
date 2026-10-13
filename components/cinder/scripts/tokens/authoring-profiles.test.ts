import { describe, expect, test } from 'bun:test';

import { TOKEN_REGISTRY } from '../../src/tokens/registry.generated.ts';
import {
  PROFILES,
  PROFILE_RULES,
  profileRangeViolation,
  selectProfile,
  type ProfileSubject,
} from './authoring-profiles.ts';
import { loadCorpus } from './generate.ts';
import { buildBaseIndex } from './registry.ts';
import { TOKEN_TYPES } from './types.ts';

function subject(overrides: Partial<ProfileSubject>): ProfileSubject {
  return { path: 'x.y', type: 'dimension', category: 'spacing', hasRecipe: false, ...overrides };
}

function violation(profile: string, value: number | string): string | undefined {
  return profileRangeViolation(PROFILES[profile]!, value);
}

describe('usage profile selection', () => {
  test('every public registry entry maps to exactly one profile', async () => {
    const { resolver, documentsByPath } = await loadCorpus();
    const baseIndex = buildBaseIndex(resolver, documentsByPath);
    expect(TOKEN_REGISTRY.entries.length).toBeGreaterThan(0);
    for (const entry of TOKEN_REGISTRY.entries) {
      const base = baseIndex.get(entry.path)!;
      const profile = selectProfile({
        path: entry.path,
        type: base.type,
        category: entry.category,
        hasRecipe: base.cssRecipe !== undefined,
      });
      expect(PROFILES[profile.id]).toBe(profile);
    }
  });

  test('maps the corpus oddities to the profile their CSS property needs', () => {
    expect(
      selectProfile(
        subject({
          path: 'tracking.tight',
          type: 'number',
          category: 'typography',
          hasRecipe: true,
        }),
      ).id,
    ).toBe('letter-spacing');
    expect(
      selectProfile(
        subject({
          path: 'content.width.prose',
          type: 'number',
          category: 'layout',
          hasRecipe: true,
        }),
      ).id,
    ).toBe('width');
    expect(
      selectProfile(subject({ path: 'ring.width', type: 'dimension', category: 'size' })).id,
    ).toBe('border-width');
    expect(
      selectProfile(subject({ path: 'ring.offset', type: 'dimension', category: 'size' })).id,
    ).toBe('offset');
    expect(selectProfile(subject({ path: 'avatar-group.overlap', type: 'dimension' })).id).toBe(
      'margin',
    );
  });

  test('every rule names a defined profile and every profile is reachable', () => {
    for (const rule of PROFILE_RULES) expect(PROFILES[rule.profile]).toBeDefined();
    const reachable = new Set(PROFILE_RULES.map((rule) => rule.profile));
    for (const id of Object.keys(PROFILES)) expect(reachable.has(id)).toBe(true);
  });

  test('every DTCG type has a profile that accepts it', () => {
    for (const type of TOKEN_TYPES) {
      expect(Object.values(PROFILES).some((profile) => profile.types.includes(type))).toBe(true);
    }
  });

  test('fails on a token no rule covers', () => {
    expect(() => selectProfile(subject({ path: 'weird.thing', category: 'spacing' }))).toThrow(
      'has no CSS usage profile',
    );
  });

  test('fails when two rules disagree', () => {
    const rules = [
      { category: 'spacing', profile: 'padding' },
      { category: 'spacing', path: /thing/, profile: 'gap' },
    ];
    expect(() => selectProfile(subject({ path: 'weird.thing' }), rules)).toThrow(
      'contradictory usage profiles: padding, gap',
    );
  });

  test('fails when the profile cannot describe the token type, unless a recipe governs the CSS', () => {
    const wrongType = subject({ path: 'opacity.x', type: 'dimension', category: 'opacity' });
    expect(() => selectProfile(wrongType)).toThrow('contradictory with profile "opacity"');
    expect(selectProfile({ ...wrongType, hasRecipe: true }).id).toBe('opacity');
  });

  test('fails on a rule that names an undefined profile', () => {
    expect(() => selectProfile(subject({}), [{ category: 'spacing', profile: 'nope' }])).toThrow(
      'unknown profile "nope"',
    );
  });
});

describe('numeric usage ranges', () => {
  test('opacity is finite and between 0 and 1', () => {
    expect(violation('opacity', 0)).toBeUndefined();
    expect(violation('opacity', 1)).toBeUndefined();
    expect(violation('opacity', 0.5)).toBeUndefined();
    expect(violation('opacity', -0.01)).toBe('must be >= 0');
    expect(violation('opacity', 1.01)).toBe('must be <= 1');
    expect(violation('opacity', Number.NaN)).toBe('must be finite');
    expect(violation('opacity', Number.POSITIVE_INFINITY)).toBe('must be finite');
  });

  test('z-index is an int32', () => {
    expect(violation('z-index', 2147483647)).toBeUndefined();
    expect(violation('z-index', -2147483648)).toBeUndefined();
    expect(violation('z-index', 2147483648)).toBe('must be <= 2147483647');
    expect(violation('z-index', -2147483649)).toBe('must be >= -2147483648');
    expect(violation('z-index', 1.5)).toBe('must be an integer');
  });

  test('font weight is 1 to 1000 or a named weight', () => {
    expect(violation('font-weight', 1)).toBeUndefined();
    expect(violation('font-weight', 1000)).toBeUndefined();
    expect(violation('font-weight', 'semi-bold')).toBeUndefined();
    expect(violation('font-weight', 0)).toBe('must be >= 1');
    expect(violation('font-weight', 1001)).toBe('must be <= 1000');
    expect(violation('font-weight', 'heavyish')).toBe('"heavyish" is not a named value');
  });

  test('duration, line height, and the box-model lengths are non-negative', () => {
    for (const id of [
      'duration',
      'line-height',
      'padding',
      'gap',
      'radius',
      'width',
      'height',
      'border-width',
      'blur',
      'size',
    ]) {
      expect(violation(id, 0)).toBeUndefined();
      expect(violation(id, -1)).toBe('must be >= 0');
    }
  });

  test('font size is strictly positive', () => {
    expect(violation('font-size', 0)).toBe('must be > 0');
    expect(violation('font-size', 0.001)).toBeUndefined();
  });

  test('offsets, margins, and letter spacing are signed', () => {
    for (const id of ['offset', 'margin', 'letter-spacing']) {
      expect(violation(id, -4)).toBeUndefined();
      expect(violation(id, 4)).toBeUndefined();
      expect(violation(id, Number.NaN)).toBe('must be finite');
    }
  });

  test('a profile without a range accepts any number', () => {
    expect(violation('color', 5)).toBeUndefined();
  });
});
