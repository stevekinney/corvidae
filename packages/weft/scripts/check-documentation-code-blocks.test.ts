import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  checkCodeBlocks,
  extractCodeBlocks,
  publishedModuleMap,
  runDocumentationCodeBlockCheck,
} from './check-documentation-code-blocks.ts';

const fence = '```';

describe('extractCodeBlocks', () => {
  test('extracts TypeScript fences and skips other languages and nested examples', () => {
    const markdown = [
      '# Guide',
      `${fence}ts`,
      'const a = 1;',
      fence,
      `${fence}bash`,
      'echo hi',
      fence,
      '````markdown',
      `${fence}ts`,
      'const quoted = 2;',
      fence,
      '````',
      `${fence}typescript`,
      'const b = 3;',
      fence,
    ].join('\n');

    const { blocks, partialCount, problems } = extractCodeBlocks('guide.md', markdown);

    expect(problems).toEqual([]);
    expect(partialCount).toBe(0);
    expect(blocks.map(({ line, fileName, source }) => ({ line, fileName, source }))).toEqual([
      { line: 2, fileName: 'line-2.ts', source: 'const a = 1;' },
      { line: 13, fileName: 'line-13.ts', source: 'const b = 3;' },
    ]);
  });

  test('skips partial blocks and names blocks with file=', () => {
    const markdown = [
      `${fence}ts partial`,
      'engine.start();',
      fence,
      `${fence}typescript file=greeting.ts`,
      'export const greeting = 1;',
      fence,
    ].join('\n');

    const { blocks, partialCount, problems } = extractCodeBlocks('guide.md', markdown);

    expect(problems).toEqual([]);
    expect(partialCount).toBe(1);
    expect(blocks.map((block) => block.fileName)).toEqual(['greeting.ts']);
  });

  test('rejects unknown attributes and duplicate file names', () => {
    const markdown = [
      `${fence}ts partail`,
      'const a = 1;',
      fence,
      `${fence}ts file=shared.ts`,
      'const b = 2;',
      fence,
      `${fence}ts file=shared.ts`,
      'const c = 3;',
      fence,
      `${fence}ts file=../escape.ts`,
      'const d = 4;',
      fence,
    ].join('\n');

    const { problems } = extractCodeBlocks('guide.md', markdown);

    expect(problems).toEqual([
      'guide.md:1: unknown code-block attribute "partail"',
      'guide.md:7: duplicate code-block file name "shared.ts"',
      'guide.md:10: unknown code-block attribute "file=../escape.ts"',
    ]);
  });

  test('removes list-item indentation from fenced bodies', () => {
    const markdown = [
      '- Step',
      '',
      `   ${fence}ts`,
      '   const a = 1;',
      '     nested();',
      `   ${fence}`,
    ];

    const { blocks } = extractCodeBlocks('guide.md', markdown.join('\n'));

    expect(blocks[0]).toMatchObject({ indent: 3, source: 'const a = 1;\n  nested();' });
  });
});

describe('checking a fixture package', () => {
  let packageRoot = '';
  let modules = new Map<string, string>();

  beforeAll(async () => {
    packageRoot = await mkdtemp(join(tmpdir(), 'documentation-code-blocks-'));
    await Bun.write(
      join(packageRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          lib: ['ESNext'],
          types: [],
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          allowImportingTsExtensions: true,
          strict: true,
          noEmit: true,
          noUnusedLocals: true,
        },
      }),
    );
    await Bun.write(
      join(packageRoot, 'src/index.ts'),
      'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
    );
    await Bun.write(join(packageRoot, 'src/extra.ts'), 'export const extra = 42;\n');
    modules = new Map([
      ['fixture', join(packageRoot, 'src/index.ts')],
      ['fixture/extra', join(packageRoot, 'src/extra.ts')],
    ]);
  });

  afterAll(async () => {
    await rm(packageRoot, { recursive: true, force: true });
  });

  test('runs over README and documentation against the published surface file', async () => {
    await Bun.write(
      join(packageRoot, 'surface.json'),
      JSON.stringify({
        packages: {
          fixture: {
            exports: { '.': { types: './dist/index.d.ts' }, './extra': './dist/extra.d.ts' },
          },
        },
      }),
    );
    await Bun.write(
      join(packageRoot, 'README.md'),
      [
        `${fence}ts`,
        "import { extra } from 'fixture/extra';",
        fence,
        `${fence}ts partial`,
        'engine;',
        fence,
      ].join('\n'),
    );
    await Bun.write(
      join(packageRoot, 'documentation/guides/guide.md'),
      ['# Guide', `${fence}ts`, "import { greet } from 'fixture';", 'greet(1);', fence].join('\n'),
    );

    const result = await runDocumentationCodeBlockCheck(
      packageRoot,
      join(packageRoot, 'surface.json'),
      'fixture',
    );

    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toStartWith('documentation/guides/guide.md:4:7 - error TS2345:');
    expect(result.summary).toBe(
      'Checked 2 documentation code blocks in 2 documents (1 partial blocks skipped); 1 problems.',
    );
  });

  test('fails when the package has no readable tsconfig.json', () => {
    expect(() => checkCodeBlocks(join(packageRoot, 'missing'), [], modules)).toThrow(
      'tsconfig.json',
    );
  });

  test('accepts published imports, relative imports between named blocks, and unused bindings', () => {
    const markdown = [
      `${fence}ts file=greeting.ts`,
      "import { greet } from 'fixture';",
      "export const greeting = greet('Steve');",
      fence,
      `${fence}ts`,
      "import { extra } from 'fixture/extra';",
      "const { greeting } = await import('./greeting.ts');",
      'const unused: number = extra;',
      'export const shout: string = greeting.toUpperCase();',
      fence,
    ].join('\n');
    const { blocks } = extractCodeBlocks('guide.md', markdown);

    expect(checkCodeBlocks(packageRoot, blocks, modules)).toEqual([]);
  });

  test('reports a type error at its Markdown line and column', () => {
    const markdown = [
      '# Guide',
      '',
      `${fence}ts`,
      "import { greet } from 'fixture';",
      '',
      'greet(1);',
      fence,
    ];
    const { blocks } = extractCodeBlocks('guide.md', markdown.join('\n'));

    const [problem, ...rest] = checkCodeBlocks(packageRoot, blocks, modules);

    expect(rest).toEqual([]);
    expect(problem).toStartWith('guide.md:6:7 - error TS2345:');
  });

  test('rejects a specifier the published surface does not export', () => {
    const markdown = [`${fence}ts`, "import { extra } from 'fixture/unpublished';", fence];
    const { blocks } = extractCodeBlocks('guide.md', markdown.join('\n'));

    const problems = checkCodeBlocks(packageRoot, blocks, modules);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('guide.md:2:23 - error TS2307:');
  });
});

describe('publishedModuleMap', () => {
  const weftRoot = resolve(import.meta.dir, '..');

  test('maps every published Weft specifier to its source file', async () => {
    const surface = await Bun.file(
      resolve(weftRoot, '../../scripts/mirror/package-surface.json'),
    ).json();

    const modules = publishedModuleMap(surface, '@lostgradient/weft', weftRoot);

    expect(modules.get('@lostgradient/weft')).toBe(join(weftRoot, 'src/index.ts'));
    expect(modules.get('@lostgradient/weft/storage/sqlite')).toBe(
      join(weftRoot, 'src/storage/sqlite.ts'),
    );
    expect(modules.get('@lostgradient/weft/testing')).toBe(join(weftRoot, 'src/testing/index.ts'));
  });

  test('fails when the surface has no entry for the package', () => {
    expect(() => publishedModuleMap({ packages: {} }, 'fixture', weftRoot)).toThrow(
      'The published package surface has no entry for fixture.',
    );
  });

  test('fails when a published export has no declaration target under dist', () => {
    const surface = { packages: { fixture: { exports: { './bad': './lib/bad.js' } } } };

    expect(() => publishedModuleMap(surface, 'fixture', weftRoot)).toThrow(
      'fixture export "./bad" has no ./dist/*.d.ts types target.',
    );
  });

  test('fails when a published types target has no source file', () => {
    const surface = {
      packages: { fixture: { exports: { './missing': { types: './dist/missing.d.ts' } } } },
    };

    expect(() => publishedModuleMap(surface, 'fixture', weftRoot)).toThrow(
      'fixture export "./missing" has no source for ./dist/missing.d.ts.',
    );
  });
});
