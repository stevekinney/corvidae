import { describe, expect, it } from 'bun:test';

import packageJson from '../package.json' with { type: 'json' };
import {
  SELF_ENTRY_POINTS,
  checkProviderImports,
  classifyFile,
  type SourceFiles,
} from './check-provider-imports.ts';

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

  it('reads tests and test support as well as source', () => {
    const tree = {
      ...CLEAN,
      'src/providers/anthropic.test.ts': `import type { Hidden } from './types.ts';`,
      'test/neutral.test.ts': `import { make } from '../src/providers/anthropic.ts';`,
      'src/providers/test/anthropic-fixtures.ts': `import type { Hidden } from '../types.ts';`,
    };

    expect(checkProviderImports(files(tree)).map((violation) => violation.file)).toEqual([
      'src/providers/anthropic.test.ts',
      'src/providers/test/anthropic-fixtures.ts',
      'test/neutral.test.ts',
    ]);

    const reachable = {
      ...tree,
      'test/neutral.test.ts': `import { ProviderError } from '../src/provider-kit.ts';`,
      'src/index.ts': `export * from './providers/index.ts'; export type { Hidden } from './providers/types.ts';`,
    };

    expect(checkProviderImports(files(reachable))).toEqual([]);
  });

  it('reads the package own entry-point specifiers like the files they name', () => {
    const violations = checkProviderImports(
      files({
        ...CLEAN,
        'test/neutral.test.ts': `import { make } from '@lostgradient/operative';`,
        'test/other.test.ts': `import { ProviderError } from '@lostgradient/operative/provider-kit';`,
      }),
    );

    expect(violations).toEqual([
      expect.objectContaining({
        file: 'test/neutral.test.ts',
        message: expect.stringContaining('imports make through src/index.ts'),
      }),
    ]);
  });

  it('keeps SELF_ENTRY_POINTS equal to the exports field of package.json', () => {
    const exported = Object.fromEntries(
      Object.entries(packageJson.exports).map(([key, value]) => [
        key === '.' ? packageJson.name : `${packageJson.name}/${key.slice(2)}`,
        value.replace(/^\.\//, ''),
      ]),
    );

    expect(SELF_ENTRY_POINTS).toEqual(exported);
  });

  describe('barrels', () => {
    it('fails when a neutral file imports a provider-owned symbol through a barrel', () => {
      const violations = checkProviderImports(
        files({ ...CLEAN, 'src/run.ts': `import { make } from './providers/index.ts';` }),
      );

      expect(violations).toEqual([
        expect.objectContaining({
          file: 'src/run.ts',
          line: 1,
          message: expect.stringContaining('imports make through src/providers/index.ts'),
        }),
      ]);
    });

    it('follows renames, nested barrels, and star re-exports to the declaring file', () => {
      const tree = {
        ...CLEAN,
        'src/providers/index.ts': `export * from './nested/index.ts'; export { errorsAlias } from './errors.ts';`,
        'src/providers/errors.ts':
          'export class ProviderError extends Error {} export const errorsAlias = 1;',
        'src/providers/nested/index.ts': `export { make as renamed } from '../anthropic.ts';`,
      };

      expect(
        checkProviderImports(
          files({ ...tree, 'src/run.ts': `import { renamed } from './providers/index.ts';` }),
        ),
      ).toEqual([
        expect.objectContaining({
          file: 'src/run.ts',
          message: expect.stringContaining('anthropic file src/providers/anthropic.ts'),
        }),
      ]);
      expect(
        checkProviderImports(
          files({ ...tree, 'src/run.ts': `import { errorsAlias } from './providers/index.ts';` }),
        ),
      ).toEqual([]);
    });

    it('fails a neutral test that imports a provider symbol through the test-support barrel', () => {
      const violations = checkProviderImports(
        files({
          ...CLEAN,
          'src/providers/test/anthropic-fixtures.ts': 'export const fixture = 1;',
          'src/providers/test/index.ts': `export { fixture } from './anthropic-fixtures.ts';`,
          'test/neutral.test.ts': `import { fixture } from '../src/index.ts';`,
          'src/index.ts': `export * from './providers/index.ts'; export * from './providers/test/index.ts';`,
        }),
      );

      expect(violations).toEqual([
        expect.objectContaining({
          file: 'test/neutral.test.ts',
          message: expect.stringContaining(
            'imports fixture through src/index.ts, declared in anthropic file src/providers/test/anthropic-fixtures.ts',
          ),
        }),
      ]);
    });

    it('fails a whole-module import of a barrel that re-exports a provider file', () => {
      const violations = checkProviderImports(
        files({
          ...CLEAN,
          'src/run.ts': `import * as providers from './providers/index.ts'; export { providers };`,
        }),
      );

      expect(violations).toEqual([
        expect.objectContaining({
          file: 'src/run.ts',
          message: expect.stringContaining('whole of barrel src/providers/index.ts'),
        }),
      ]);
    });

    it('fails when one provider imports another provider symbol through a barrel', () => {
      const violations = checkProviderImports(
        files({
          ...CLEAN,
          'src/providers/openai.ts': `import { make } from './index.ts';`,
        }),
      );

      expect(violations).toEqual([
        expect.objectContaining({
          file: 'src/providers/openai.ts',
          message: expect.stringContaining('openai file imports make through'),
        }),
      ]);
    });

    it('lets a barrel and a provider file re-export or import provider symbols', () => {
      expect(
        checkProviderImports(
          files({
            ...CLEAN,
            'src/providers/test/anthropic-fixtures.ts': `import { make } from '../index.ts'; export const fixture = make;`,
          }),
        ),
      ).toEqual([]);
    });
  });
});
