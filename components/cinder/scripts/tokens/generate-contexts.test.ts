import { describe, expect, test } from 'bun:test';
import { buildTokensBaseCss } from './css-generator.ts';
import { buildResolvedContexts, documentsForResolutionOrder } from './resolved-contexts.ts';
import type { ResolverDocument, TokenDocument } from './types.ts';
function motionFixture() {
  const baseDocument: TokenDocument = {
    duration: {
      $type: 'duration',
      instant: {
        $value: { value: 0, unit: 'ms' },
        $extensions: { 'com.lostgradient.cinder': { cssProperty: '--test-duration' } },
      },
    },
  };
  const themeDocument: TokenDocument = {};
  const motionDefaultDocument: TokenDocument = {};
  // The `reduced` and `forced-reduced-motion` contexts deliberately hold
  // DIFFERENT override values -- the real corpus's two motion documents
  // happen to agree today, which is exactly why this bug was silent there.
  const motionReducedDocument: TokenDocument = {
    duration: { $type: 'duration', instant: { $value: { value: 1, unit: 'ms' } } },
  };
  const motionForcedDocument: TokenDocument = {
    duration: { $type: 'duration', instant: { $value: { value: 2, unit: 'ms' } } },
  };

  const resolver: ResolverDocument = {
    version: '2025.10',
    sets: { foundation: { sources: [{ $ref: 'base.json' }] } },
    modifiers: {
      theme: {
        contexts: {
          light: [{ $ref: 'theme-light.json' }],
          dark: [{ $ref: 'theme-dark.json' }],
        },
        default: 'light',
      },
      motion: {
        contexts: {
          default: [{ $ref: 'motion-default.json' }],
          reduced: [{ $ref: 'motion-reduced.json' }],
          'forced-reduced-motion': [{ $ref: 'motion-forced.json' }],
        },
        default: 'default',
      },
    },
    resolutionOrder: [
      { $ref: '#/sets/foundation' },
      { $ref: '#/modifiers/theme' },
      { $ref: '#/modifiers/motion' },
    ],
  };

  const documentsByPath = new Map<string, TokenDocument>([
    ['base.json', baseDocument],
    ['theme-light.json', themeDocument],
    ['theme-dark.json', themeDocument],
    ['motion-default.json', motionDefaultDocument],
    ['motion-reduced.json', motionReducedDocument],
    ['motion-forced.json', motionForcedDocument],
  ]);

  return { resolver, documentsByPath };
}

describe('A1: the forced-reduced-motion selector is built from its own context', () => {
  test('the data-reduced-motion="on" override uses the forced-reduced-motion context, not reduced', async () => {
    const { resolver, documentsByPath } = motionFixture();
    const css = await buildTokensBaseCss(resolver, documentsByPath);

    const forcedBlock = /:root\[data-reduced-motion='on'\]\s*\{([^}]*)\}/.exec(css)?.[1];
    const mediaBlock =
      /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}\n\n:root\[data-reduced-motion='on'\]/.exec(
        css,
      )?.[1];

    expect(forcedBlock).toBeDefined();
    expect(mediaBlock).toBeDefined();

    // The forced block must carry the forced-reduced-motion context's value
    // (2ms), and the media block must keep carrying the reduced context's
    // value (1ms) -- proving the two selectors now read from two different
    // contexts instead of both reading `reduced`.
    expect(forcedBlock).toContain('--test-duration: 2ms;');
    expect(forcedBlock).not.toContain('1ms');
    expect(mediaBlock).toContain('--test-duration: 1ms;');
    expect(css).not.toMatch(/\[data-theme='(?:dark|light)'\]\s*\{[^}]*--test-duration/);
  });
});

describe('A2: resolved snapshots walk resolutionOrder instead of a hardcoded order', () => {
  test('document assembly order follows resolutionOrder, not a hardcoded [foundation, theme, motion]', () => {
    const baseDocument: TokenDocument = { token: { $type: 'number', $value: 1 } };
    const themeLightDocument: TokenDocument = { token: { $value: 2 } };
    const motionDefaultDocument: TokenDocument = {};

    // resolutionOrder deliberately reverses the sets/foundation and
    // modifiers/theme entries relative to their conventional order, so
    // hardcoded [foundation, theme, motion] assembly and resolutionOrder-driven
    // assembly disagree on which document comes last (and therefore wins the
    // merge for the colliding "token" path).
    const resolver: ResolverDocument = {
      version: '2025.10',
      sets: { foundation: { sources: [{ $ref: 'base.json' }] } },
      modifiers: {
        theme: { contexts: { light: [{ $ref: 'theme-light.json' }] }, default: 'light' },
        motion: { contexts: { default: [{ $ref: 'motion-default.json' }] }, default: 'default' },
      },
      resolutionOrder: [
        { $ref: '#/modifiers/theme' },
        { $ref: '#/sets/foundation' },
        { $ref: '#/modifiers/motion' },
      ],
    };
    const documentsByPath = new Map<string, TokenDocument>([
      ['base.json', baseDocument],
      ['theme-light.json', themeLightDocument],
      ['motion-default.json', motionDefaultDocument],
    ]);

    const documents = documentsForResolutionOrder(resolver, documentsByPath, {
      theme: 'light',
      motion: 'default',
    });

    expect(documents).toEqual([themeLightDocument, baseDocument, motionDefaultDocument]);
  });

  test('a reordered resolutionOrder changes which value wins a resolved snapshot', async () => {
    const baseDocument: TokenDocument = { token: { $type: 'number', $value: 1 } };
    const themeLightDocument: TokenDocument = { token: { $value: 2 } };
    const themeDarkDocument: TokenDocument = { token: { $value: 3 } };
    const motionDefaultDocument: TokenDocument = {};
    const motionReducedDocument: TokenDocument = {};

    const resolver: ResolverDocument = {
      version: '2025.10',
      sets: { foundation: { sources: [{ $ref: 'base.json' }] } },
      modifiers: {
        theme: {
          contexts: {
            light: [{ $ref: 'theme-light.json' }],
            dark: [{ $ref: 'theme-dark.json' }],
          },
          default: 'light',
        },
        motion: {
          contexts: {
            default: [{ $ref: 'motion-default.json' }],
            reduced: [{ $ref: 'motion-reduced.json' }],
          },
          default: 'default',
        },
      },
      // Theme now comes BEFORE foundation, so foundation's value should win
      // for a token both documents define.
      resolutionOrder: [
        { $ref: '#/modifiers/theme' },
        { $ref: '#/sets/foundation' },
        { $ref: '#/modifiers/motion' },
      ],
    };
    const documentsByPath = new Map<string, TokenDocument>([
      ['base.json', baseDocument],
      ['theme-light.json', themeLightDocument],
      ['theme-dark.json', themeDarkDocument],
      ['motion-default.json', motionDefaultDocument],
      ['motion-reduced.json', motionReducedDocument],
    ]);

    const resolved = await buildResolvedContexts(resolver, documentsByPath);
    const lightJson = resolved.get('light');
    expect(lightJson).toBeDefined();
    const parsed = JSON.parse(lightJson!);

    // foundation's value (1) wins because it now comes AFTER theme in
    // resolutionOrder; a hardcoded [foundation, theme, motion] assembly would
    // have produced 2 (theme's value) instead.
    expect(parsed['token']?.$value).toBe(1);
  });
});
