/**
 * COR-2075: two component stylesheets wrote a value a token already carries, and
 * `check-design-token-literals --strict` now refuses that. Each literal was swapped for the token,
 * and the swap may not change what a consumer sees. This pins the two tokens to the literals they
 * replaced, in every resolved theme the generated CSS comes from.
 *
 * `font.medium` is 500 in all of them. `motion.pulse` is 1.4s wherever motion runs and 0ms in the
 * reduced-motion themes, where the literal never applied either: the component's own rule and the
 * foundation's forced opt-in both set `animation: none` there. The second block asserts those two
 * rules, so removing one of them fails here instead of quietly changing the reduced-motion render.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse, type AtRule, type Rule } from 'postcss';

import { readJsonRecord } from '../styles/token-contrast-test-readers.ts';

const TOKENS_DIRECTORY = import.meta.dirname;
const SOURCE_DIRECTORY = join(TOKENS_DIRECTORY, '..');

const themes = readdirSync(join(TOKENS_DIRECTORY, 'resolved'))
  .filter((name) => name.endsWith('.json'))
  .toSorted();
const reducedMotionThemes = themes.filter((name) => name.endsWith('-reduced-motion.json'));
const fullMotionThemes = themes.filter((name) => !name.endsWith('-reduced-motion.json'));

/** A token's resolved value and the custom property the generated CSS declares it under. */
function readToken(theme: string, path: string): { value: unknown; cssProperty: unknown } {
  const context = readJsonRecord(TOKENS_DIRECTORY, 'resolved', theme);
  const token = context[path] as
    | { $value?: unknown; $extensions?: { 'com.lostgradient.cinder'?: { cssProperty?: unknown } } }
    | undefined;
  return {
    value: token?.$value,
    cssProperty: token?.$extensions?.['com.lostgradient.cinder']?.cssProperty,
  };
}

function readStylesheet(...segments: string[]) {
  return parse(readFileSync(join(SOURCE_DIRECTORY, ...segments), 'utf8'));
}

/** The value a rule gives `property`, with its `!important` flag. */
function declarationOf(rule: Rule, property: string): string | undefined {
  let found: string | undefined;
  rule.walkDecls(property, (declaration) => {
    found = declaration.important ? `${declaration.value} !important` : declaration.value;
  });
  return found;
}

describe('the tokens that replaced literals in component CSS', () => {
  test('covers the four resolved themes', () => {
    expect(themes).toEqual([
      'dark-reduced-motion.json',
      'dark.json',
      'light-reduced-motion.json',
      'light.json',
    ]);
  });

  test.each(themes)('font.medium is the 500 that code-block.css wrote, in %s', (theme) => {
    expect(readToken(theme, 'font.medium')).toEqual({
      value: 500,
      cssProperty: '--cinder-font-medium',
    });
  });

  test.each(fullMotionThemes)(
    'motion.pulse is the 1.4s that run-step-timeline.css wrote, in %s',
    (theme) => {
      expect(readToken(theme, 'motion.pulse')).toEqual({
        value: { value: 1.4, unit: 's' },
        cssProperty: '--cinder-duration-pulse',
      });
    },
  );

  test.each(reducedMotionThemes)('motion.pulse is zero in %s', (theme) => {
    expect(readToken(theme, 'motion.pulse')).toEqual({
      value: { value: 0, unit: 'ms' },
      cssProperty: '--cinder-duration-pulse',
    });
  });
});

describe('where motion.pulse is zero, the tool pulse was already off', () => {
  const pulseSelector = '.cinder-run-step-timeline__icon [data-cinder-tool-activity-active]';

  test('the component reads the token for its pulse', () => {
    const rules: Rule[] = [];
    readStylesheet('components', 'run-step-timeline', 'run-step-timeline.css').walkRules(
      pulseSelector,
      (rule) => {
        if ((rule.parent as AtRule).name !== 'media') rules.push(rule);
      },
    );

    expect(rules.map((rule) => declarationOf(rule, 'animation'))).toEqual([
      'cinder-run-step-timeline-tool-pulse var(--cinder-duration-pulse) ease-in-out infinite',
    ]);
  });

  test('the component turns the pulse off under the system preference', () => {
    const values: Array<string | undefined> = [];
    readStylesheet('components', 'run-step-timeline', 'run-step-timeline.css').walkAtRules(
      'media',
      (media) => {
        if (media.params !== '(prefers-reduced-motion: reduce)') return;
        media.walkRules(pulseSelector, (rule) => {
          values.push(declarationOf(rule, 'animation'));
        });
      },
    );

    expect(values).toEqual(['none']);
  });

  test('the foundation turns every animation off under the forced opt-in', () => {
    const values: Array<string | undefined> = [];
    readStylesheet('styles', 'foundation.css').walkRules((rule) => {
      if (rule.selectors.includes(":root[data-reduced-motion='on'] *")) {
        values.push(declarationOf(rule, 'animation'));
      }
    });

    expect(values).toEqual(['none !important']);
  });
});
