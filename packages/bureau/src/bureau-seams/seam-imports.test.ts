/**
 * COR-2376 — a seam imports only leaf modules and its own directory's `./core.ts`, never the file it
 * was cut out of (`create-bureau.ts`, directly or through the package barrel, which re-exports it,
 * or `runtime-composition.ts`) and never another seam of either directory, so the seams cannot form
 * an import cycle. The `import/no-cycle` lint does not count type-only imports, so this guard reads
 * every import form, `import type` included, in every file under `bureau-seams/` (the seams of
 * `constructBureau`) and `composition-seams/` (the seams of `buildRuntimeComposition`),
 * subdirectories included.
 */
import { readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { describe, expect, it } from 'bun:test';
import ts from 'typescript';

const SEAMS_DIRECTORY = import.meta.dir;
const SOURCE_DIRECTORY = dirname(SEAMS_DIRECTORY);
const COMPOSITION_SEAMS_DIRECTORY = join(SOURCE_DIRECTORY, 'composition-seams');
/** Each seam directory; a seam in one may import only that directory's `core.ts`. */
const SEAM_DIRECTORIES = [SEAMS_DIRECTORY, COMPOSITION_SEAMS_DIRECTORY];
/** The two parents, and the barrel (`src/index.ts`, also named by `'..'`) that re-exports one. */
const COMPOSITION_MODULES = new Set([
  join(SOURCE_DIRECTORY, 'create-bureau'),
  join(SOURCE_DIRECTORY, 'runtime-composition'),
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
 * The specifiers in `sourceText`, a file in `directory` under the seam directory `seams`, that name
 * a parent, the barrel, or anything under either seam directory other than `seams/core.ts`.
 */
function forbiddenImports(
  sourceText: string,
  directory = SEAMS_DIRECTORY,
  seams = SEAMS_DIRECTORY,
): string[] {
  const core = join(seams, 'core');
  return moduleSpecifiers(sourceText).filter((specifier) => {
    if (!specifier.startsWith('.')) return false;
    const target = resolve(directory, specifier).replace(/\.(ts|js)$/, '');
    if (COMPOSITION_MODULES.has(target)) return true;
    const inSeams = SEAM_DIRECTORIES.some(
      (seamDirectory) => target === seamDirectory || target.startsWith(`${seamDirectory}${sep}`),
    );
    return inSeams && target !== core;
  });
}

/** Every non-test `.ts` file under the seam directory `seams`, as a path relative to it. */
async function seamFiles(seams: string): Promise<string[]> {
  const entries = await readdir(seams, { recursive: true });
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

  it('allows a composition seam its own core only, and reports runtime-composition.ts', () => {
    expect(
      forbiddenImports(
        `
          import type { CompositionCore } from './core';
          import type { BureauToolbox } from '../runtime-composition-types';
          import { createRuntimeComposition } from '../runtime-composition';
          import type { BureauCore } from '../bureau-seams/core';
          import { createOther } from './other-seam';
          import { createLiveFrames } from '../bureau-seams/live-frames.ts';
        `,
        COMPOSITION_SEAMS_DIRECTORY,
        COMPOSITION_SEAMS_DIRECTORY,
      ),
    ).toEqual([
      '../runtime-composition',
      '../bureau-seams/core',
      './other-seam',
      '../bureau-seams/live-frames.ts',
    ]);
    expect(
      forbiddenImports(`
        import { createRuntimeComposition } from '../runtime-composition.ts';
        import type { CompositionCore } from '../composition-seams/core';
      `),
    ).toEqual(['../runtime-composition.ts', '../composition-seams/core']);
  });
});

for (const seams of SEAM_DIRECTORIES) {
  describe(basename(seams), () => {
    it('imports neither a parent, the barrel, nor another seam', async () => {
      const files = await seamFiles(seams);
      // A guard over a directory with no seam in it would pass silently.
      expect(files).toContain('core.ts');
      expect(files.filter((file) => file !== 'core.ts').length).toBeGreaterThan(0);

      const found: string[] = [];
      for (const file of files) {
        const path = join(seams, file);
        const text = await Bun.file(path).text();
        found.push(
          ...forbiddenImports(text, dirname(path), seams).map(
            (specifier) =>
              `${file}: ${specifier} (import from a leaf module or ./core.ts instead; a seam reaches another seam only through \`peers\`)`,
          ),
        );
      }

      expect(found).toEqual([]);
    });
  });
}
