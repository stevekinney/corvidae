/**
 * COR-2376 — a seam of `constructBureau` imports only leaf modules and `./core.ts`, never
 * `create-bureau.ts` (directly or through the package barrel, which re-exports it) and never
 * another seam, so the seams cannot form an import cycle. The `import/no-cycle` lint does not count
 * type-only imports, so this guard reads every import form, `import type` included, in every file
 * under `bureau-seams/`, subdirectories included.
 */
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { describe, expect, it } from 'bun:test';
import ts from 'typescript';

const SEAMS_DIRECTORY = import.meta.dir;
const SOURCE_DIRECTORY = dirname(SEAMS_DIRECTORY);
const CORE = join(SEAMS_DIRECTORY, 'core');
/** `create-bureau.ts`, and the barrel (`src/index.ts`, also named by `'..'`) that re-exports it. */
const COMPOSITION_MODULES = new Set([
  join(SOURCE_DIRECTORY, 'create-bureau'),
  join(SOURCE_DIRECTORY, 'index'),
  SOURCE_DIRECTORY,
]);

/** Every module specifier `sourceText` names: static, type-only, re-export, and dynamic. */
function moduleSpecifiers(sourceText: string): string[] {
  const source = ts.createSourceFile('seam.ts', sourceText, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      found.push(node.argument.literal.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * The specifiers in `sourceText`, a file in `directory`, that name `create-bureau.ts`, the barrel,
 * or anything under `bureau-seams/` other than `core.ts`.
 */
function forbiddenImports(sourceText: string, directory = SEAMS_DIRECTORY): string[] {
  return moduleSpecifiers(sourceText).filter((specifier) => {
    if (!specifier.startsWith('.')) return false;
    const target = resolve(directory, specifier).replace(/\.(ts|js)$/, '');
    if (COMPOSITION_MODULES.has(target)) return true;
    const inSeams = target === SEAMS_DIRECTORY || target.startsWith(`${SEAMS_DIRECTORY}${sep}`);
    return inSeams && target !== CORE;
  });
}

/** Every non-test `.ts` file under `bureau-seams/`, as a path relative to it. */
async function seamFiles(): Promise<string[]> {
  const entries = await readdir(SEAMS_DIRECTORY, { recursive: true });
  return entries.filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).toSorted();
}

describe('forbiddenImports', () => {
  it('reports create-bureau, the barrel and another seam in every import form', () => {
    expect(
      forbiddenImports(`
        import { createBureau } from '../create-bureau';
        import type { Bureau } from '../create-bureau.ts';
        import { createBureau as viaJs } from '../create-bureau.js';
        import { createBureau as viaBarrel } from '..';
        import type { BureauOptions } from '../index';
        import { createOther } from './other-seam';
        export { thing } from './other-seam.ts';
        type Lazy = import('./other-seam').Other;
        const later = () => import('../create-bureau');
        import { nested } from './nested/seam';
        import { all } from '.';
      `),
    ).toEqual([
      '../create-bureau',
      '../create-bureau.ts',
      '../create-bureau.js',
      '..',
      '../index',
      './other-seam',
      './other-seam.ts',
      './other-seam',
      '../create-bureau',
      './nested/seam',
      '.',
    ]);
  });

  it('resolves a file in a subdirectory from its own directory', () => {
    expect(
      forbiddenImports(
        `
          import type { BureauCore } from '../core';
          import { createBureau } from '../../create-bureau';
          import { createOther } from '../other-seam';
        `,
        join(SEAMS_DIRECTORY, 'nested'),
      ),
    ).toEqual(['../../create-bureau', '../other-seam']);
  });

  it('allows the core and leaf modules', () => {
    expect(
      forbiddenImports(`
        import type { BureauCore } from './core';
        import { STEERING_APPEND_ATTEMPTS } from './core.ts';
        import { serializeUnknownError } from '../serialization';
        import type { Subscription } from '@lostgradient/operative';
        import { createBureauEventFeed } from '../bureau-event-feed.ts';
      `),
    ).toEqual([]);
  });
});

describe('bureau-seams', () => {
  it('imports neither create-bureau.ts, the barrel, nor another seam', async () => {
    const files = await seamFiles();
    expect(files).toContain('core.ts');

    const found: string[] = [];
    for (const file of files) {
      const path = join(SEAMS_DIRECTORY, file);
      const text = await Bun.file(path).text();
      found.push(
        ...forbiddenImports(text, dirname(path)).map(
          (specifier) =>
            `${file}: ${specifier} (import from a leaf module or ./core.ts instead; a seam reaches another seam only through \`peers\`)`,
        ),
      );
    }

    expect(found).toEqual([]);
  });
});
