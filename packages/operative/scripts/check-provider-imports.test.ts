import { describe, expect, it } from 'bun:test';

import { checkProviderImports, classifyFile, type SourceFiles } from './check-provider-imports.ts';

function files(entries: Record<string, string>): SourceFiles {
  return new Map(Object.entries(entries));
}

const PROVIDER_KIT = `export { ProviderError } from './providers/errors.ts';
export type { GenerateFunction } from './providers/types.ts';`;

const CLEAN = {
  'src/provider-kit.ts': PROVIDER_KIT,
  'src/providers/errors.ts': 'export class ProviderError extends Error {}',
  'src/providers/types.ts': 'export type GenerateFunction = () => void; export type Hidden = 1;',
  'src/providers/anthropic.ts': `import { ProviderError } from './errors.ts';
import type { GenerateFunction } from './types.ts';
import { toolChoice } from './anthropic-tool-choice.ts';
export const make = (): GenerateFunction => () => { throw new ProviderError(); };`,
  'src/providers/anthropic-tool-choice.ts': 'export const toolChoice = 1;',
  'src/providers/openai.ts': `import { ProviderError } from './errors.ts';`,
  'src/providers/index.ts': `export { make } from './anthropic.ts';`,
  'src/index.ts': `export * from './providers/index.ts';`,
  'src/run.ts': `import type { GenerateFunction } from './providers/types.ts';`,
} as const;

describe('classifyFile', () => {
  it.each([
    ['src/anthropic.ts', { kind: 'provider', provider: 'anthropic' }],
    ['src/providers/openai.ts', { kind: 'provider', provider: 'openai' }],
    ['src/providers/gemini-parts.ts', { kind: 'provider', provider: 'gemini' }],
    [
      'src/providers/anthropic-client-assignability.test-d.ts',
      { kind: 'provider', provider: 'anthropic' },
    ],
    ['src/providers/batches/gemini.ts', { kind: 'provider', provider: 'gemini' }],
    ['src/providers/embeddings/openai.ts', { kind: 'provider', provider: 'openai' }],
    ['src/providers/embeddings/ollama.ts', { kind: 'neutral' }],
    ['src/providers/streaming/normalize-openai.ts', { kind: 'provider', provider: 'openai' }],
    ['src/providers/streaming/stream-helpers.ts', { kind: 'neutral' }],
    ['src/providers/test/gemini-fixtures.ts', { kind: 'provider', provider: 'gemini' }],
    ['src/providers/test/index.ts', { kind: 'barrel' }],
    ['test/anthropic/browser.test.ts', { kind: 'provider', provider: 'anthropic' }],
    ['src/index.ts', { kind: 'barrel' }],
    ['src/providers/index.ts', { kind: 'barrel' }],
    ['src/providers/batches/index.ts', { kind: 'barrel' }],
    ['src/streaming/index.ts', { kind: 'neutral' }],
    ['src/providers/shared/effort.ts', { kind: 'neutral' }],
    ['src/providers/anthropicish.ts', { kind: 'neutral' }],
  ] as const)('%s', (path, expected) => {
    expect(classifyFile(path)).toEqual(expected);
  });
});

describe('checkProviderImports', () => {
  it('passes a tree that respects the boundary', () => {
    expect(checkProviderImports(files(CLEAN))).toEqual([]);
  });

  it('fails when a neutral non-barrel file imports a provider file', () => {
    const violations = checkProviderImports(
      files({ ...CLEAN, 'src/run.ts': `import { make } from './providers/anthropic';` }),
    );

    expect(violations).toEqual([
      expect.objectContaining({
        file: 'src/run.ts',
        message: expect.stringContaining('provider-neutral file imports anthropic file'),
      }),
    ]);
  });

  it('reads import type, export from, require, and dynamic import()', () => {
    for (const source of [
      `import type { make } from './providers/anthropic.ts';`,
      `export { make } from './providers/anthropic';`,
      `export * from './providers/anthropic.ts';`,
      `const loaded = await import('./providers/anthropic.ts');`,
      `type Make = typeof import('./providers/anthropic.ts').make;`,
    ]) {
      const violations = checkProviderImports(files({ ...CLEAN, 'src/run.ts': source }));

      expect(violations).toHaveLength(1);
    }
  });

  it('fails when one provider imports another provider', () => {
    const violations = checkProviderImports(
      files({
        ...CLEAN,
        'src/providers/openai.ts': `import { toolChoice } from './anthropic-tool-choice.ts';`,
      }),
    );

    expect(violations).toEqual([
      expect.objectContaining({
        file: 'src/providers/openai.ts',
        message: expect.stringContaining('openai file imports anthropic file'),
      }),
    ]);
  });

  it('fails on a symbol a provider imports by name that provider-kit does not export', () => {
    const violations = checkProviderImports(
      files({
        ...CLEAN,
        'src/providers/anthropic.ts': `import type { Hidden } from './types.ts';`,
      }),
    );

    expect(violations).toEqual([
      expect.objectContaining({
        file: 'src/providers/anthropic.ts',
        message: expect.stringMatching(
          /imports Hidden from neutral module src\/providers\/types\.ts/,
        ),
      }),
    ]);
  });

  it('fails on a whole-module import of a neutral module from a provider file', () => {
    const violations = checkProviderImports(
      files({
        ...CLEAN,
        'src/providers/anthropic.ts': `import * as errors from './errors.ts'; export { errors };`,
      }),
    );

    expect(violations).toEqual([
      expect.objectContaining({ message: expect.stringContaining('whole of neutral module') }),
    ]);
  });

  it('skips tests by default and applies the test entry rule with includeTests', () => {
    const tree = {
      ...CLEAN,
      'src/providers/anthropic.test.ts': `import type { Hidden } from './types.ts';`,
    };

    expect(checkProviderImports(files(tree))).toEqual([]);
    expect(checkProviderImports(files(tree), { includeTests: true })).toHaveLength(1);

    const reachable = {
      ...tree,
      'src/index.ts': `export * from './providers/index.ts'; export type { Hidden } from './providers/types.ts';`,
    };

    expect(checkProviderImports(files(reachable), { includeTests: true })).toEqual([]);
  });
});
