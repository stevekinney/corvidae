import { describe, expect, test } from 'bun:test';
import { type CorpusEntry } from './corpus.ts';
import { buildTokensBaseCss } from './css-generator.ts';
import {
  assertOverrideScopeConsistency,
  assertUniqueOverrideCssProperties,
} from './css-support.ts';
import { buildGeneratedOutputs } from './generate.ts';
import { tokensBaseCssPath } from './generator-configuration.ts';
import type { ResolverDocument, TokenDocument } from './types.ts';
const entry = (value: unknown): CorpusEntry => ({
  path: 'test.token',
  value,
  type: 'color',
  description: undefined,
  cssProperty: '--test-token',
  cssRecipe: undefined,
});

const token = (value: unknown, cssProperty?: string): Record<string, unknown> => ({
  $type: typeof value === 'number' ? 'number' : 'color',
  $value: value,
  ...(cssProperty ? { $extensions: { 'com.lostgradient.cinder': { cssProperty } } } : {}),
});

describe('CIN-488 through CIN-493 follow-up guards', () => {
  test('rejects a motion override whose serialized value differs by theme when scope consistency is required', () => {
    const overrides = new Map([
      [
        'test.token',
        {
          ...entry('#/source/$value/components'),
          isRefAlias: true,
        },
      ],
    ]);
    const baseIndex = new Map([
      ['test.token', entry({ colorSpace: 'oklch', components: [0.5, 0.1, 250] })],
    ]);
    expect(() =>
      assertOverrideScopeConsistency(
        overrides,
        baseIndex,
        [
          {
            name: 'theme.light',
            resolveReferences: () => ({ colorSpace: 'oklch', components: [0.9, 0.1, 250] }),
          },
          {
            name: 'theme.dark',
            resolveReferences: () => ({ colorSpace: 'oklch', components: [0.4, 0.1, 250] }),
          },
        ],
        'motion.reduced',
      ),
    ).toThrow(/serializes differently across reachable scopes/);
  });

  test('motion override uniqueness can be checked against the unthemed system scope', () => {
    const base = new Map([
      ['a', { ...entry(1), path: 'a' }],
      ['b', { ...entry(1), path: 'b' }],
    ]);
    const override = new Map([['a', { ...entry(2), path: 'a' }]]);
    expect(() =>
      assertUniqueOverrideCssProperties(override, base, base, 'motion.reduced (system theme)'),
    ).toThrow(/system theme/);
  });

  test('omits theme-specific motion selectors when no aliases need recomputation', async () => {
    const generatedOutputs = await buildGeneratedOutputs();
    const css = generatedOutputs.get(tokensBaseCssPath)!;
    expect(css).not.toContain(":root[data-theme='dark']:not([data-cinder-reduced-motion='false'])");
    expect(css).not.toContain(
      ":root[data-theme='light']:not([data-cinder-reduced-motion='false'])",
    );
    expect(css).not.toContain(":root[data-reduced-motion='on'][data-theme='dark']");
    expect(css).not.toContain(":root[data-reduced-motion='on'][data-theme='light']");
  });

  test('scoped theme blocks do not mask ancestor overrides for dynamic component aliases', async () => {
    const generatedOutputs = await buildGeneratedOutputs();
    const css = generatedOutputs.get(tokensBaseCssPath)!;
    const darkBlock = css.match(/\n\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const lightBlock = css.match(/\n\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';

    for (const block of [darkBlock, lightBlock]) {
      expect(block).not.toContain('--cinder-file-upload-background:');
      expect(block).not.toContain('--cinder-kanban-card-background:');
    }
  });

  test('rejects a non-empty motion.default document instead of dropping it from CSS', async () => {
    const base = {
      token: {
        $type: 'number',
        $value: 1,
        $extensions: { 'com.lostgradient.cinder': { cssProperty: '--test-token' } },
      },
    } as TokenDocument;
    const resolver: ResolverDocument = {
      version: '2025.10',
      sets: { foundation: { sources: [{ $ref: 'base.json' }] } },
      modifiers: {
        theme: {
          contexts: { light: [{ $ref: 'light.json' }], dark: [{ $ref: 'dark.json' }] },
          default: 'light',
        },
        motion: {
          contexts: {
            default: [{ $ref: 'default.json' }],
            reduced: [{ $ref: 'reduced.json' }],
            'forced-reduced-motion': [{ $ref: 'forced.json' }],
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
    expect(
      buildTokensBaseCss(
        resolver,
        new Map([
          ['base.json', base],
          ['light.json', {}],
          ['dark.json', {}],
          ['default.json', { token: { $value: 2 } }],
          ['reduced.json', {}],
          ['forced.json', {}],
        ]),
      ),
    ).rejects.toThrow(/motion\.default must not declare token overrides/);
  });

  test('rejects group metadata in motion.default documents', async () => {
    const base = {
      token: {
        $type: 'number',
        $value: 1,
        $extensions: { 'com.lostgradient.cinder': { cssProperty: '--test-token' } },
      },
    } as TokenDocument;
    const resolver: ResolverDocument = {
      version: '2025.10',
      sets: { foundation: { sources: [{ $ref: 'base.json' }] } },
      modifiers: {
        theme: {
          contexts: { light: [{ $ref: 'light.json' }], dark: [{ $ref: 'dark.json' }] },
          default: 'light',
        },
        motion: {
          contexts: {
            default: [{ $ref: 'default.json' }],
            reduced: [{ $ref: 'reduced.json' }],
            'forced-reduced-motion': [{ $ref: 'forced.json' }],
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
    expect(
      buildTokensBaseCss(
        resolver,
        new Map([
          ['base.json', base],
          ['light.json', {}],
          ['dark.json', {}],
          ['default.json', { $type: 'fontWeight' }],
          ['reduced.json', {}],
          ['forced.json', {}],
        ]),
      ),
    ).rejects.toThrow(/motion\.default must not declare.*group metadata/);
  });

  test('root motion aliases resolve from the unthemed system scope', async () => {
    const baseDocument: TokenDocument = {
      test: {
        lightness: token(0.3, '--test-lightness'),
        chroma: token(0.1, '--test-chroma'),
        composite: token(
          {
            colorSpace: 'oklch',
            components: ['{test.lightness}', '{test.chroma}', 250],
          },
          '--test-composite',
        ),
      },
    };
    const resolver: ResolverDocument = {
      version: '2025.10',
      sets: { foundation: { sources: [{ $ref: 'base.json' }] } },
      modifiers: {
        theme: {
          contexts: {
            light: [{ $ref: 'light.json' }],
            dark: [{ $ref: 'dark.json' }],
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
      ['light.json', { test: { lightness: { $type: 'number', $value: 0.9 } } }],
      ['dark.json', { test: { lightness: { $type: 'number', $value: 0.4 } } }],
      ['motion-default.json', {}],
      ['motion-reduced.json', { test: { chroma: { $type: 'number', $value: 0.2 } } }],
      ['motion-forced.json', {}],
    ]);

    const css = await buildTokensBaseCss(resolver, documentsByPath);
    const mediaBlock = css.match(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?:root[^{}]*\{([^}]*)\}/,
    )?.[1];
    expect(mediaBlock).toContain('--test-composite: oklch(30% 0.2 250);');
    expect(mediaBlock).not.toContain('oklch(90% 0.2 250)');
  });
});
