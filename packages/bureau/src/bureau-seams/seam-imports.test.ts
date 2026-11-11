/**
 * COR-2376 — a seam of `constructBureau` imports only leaf modules and `./core.ts`, never
 * `create-bureau.ts` and never another seam, so the seams cannot form an import cycle. The
 * `import/no-cycle` lint does not count type-only imports, so this guard reads every import form,
 * `import type` included.
 */
import { readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'bun:test';
import ts from 'typescript';

const SEAMS_DIRECTORY = import.meta.dir;
const CREATE_BUREAU = resolve(SEAMS_DIRECTORY, '..', 'create-bureau');

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

/** The specifiers in `sourceText` that name `create-bureau.ts` or a seam other than `./core.ts`. */
function forbiddenImports(sourceText: string): string[] {
  return moduleSpecifiers(sourceText).filter((specifier) => {
    if (!specifier.startsWith('.')) return false;
    const target = resolve(SEAMS_DIRECTORY, specifier).replace(/\.ts$/, '');
    if (target === CREATE_BUREAU) return true;
    return dirname(target) === SEAMS_DIRECTORY && basename(target) !== 'core';
  });
}

describe('forbiddenImports', () => {
  it('reports create-bureau and another seam in every import form', () => {
    expect(
      forbiddenImports(`
        import { createBureau } from '../create-bureau';
        import type { Bureau } from '../create-bureau.ts';
        import { createOther } from './other-seam';
        export { thing } from './other-seam.ts';
        type Lazy = import('./other-seam').Other;
        const later = () => import('../create-bureau');
      `),
    ).toEqual([
      '../create-bureau',
      '../create-bureau.ts',
      './other-seam',
      './other-seam.ts',
      './other-seam',
      '../create-bureau',
    ]);
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
  it('imports neither create-bureau.ts nor another seam', async () => {
    const entries = await readdir(SEAMS_DIRECTORY);
    const files = entries.filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    expect(files).toContain('core.ts');

    const found: string[] = [];
    for (const file of files.toSorted()) {
      const text = await Bun.file(join(SEAMS_DIRECTORY, file)).text();
      found.push(...forbiddenImports(text).map((specifier) => `${file}: ${specifier}`));
    }

    expect(found).toEqual([]);
  });
});
