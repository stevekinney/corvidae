import { describe, expect, it } from 'bun:test';
import {
  childNodes,
  isNode,
  nodeField,
  parseSvelte,
  scriptStatements,
  type AstNode,
} from '../../test/svelte-ast.ts';

const PROTECTED_PREFIXES = ['@milkdown/', 'prosemirror-'] as const;

function isProtected(specifier: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}

type DynamicImportInfo = {
  specifier: string | null;
  guardedByEarlyReturn: boolean;
};

function isEarlyBrowserReturnGuard(statement: unknown): boolean {
  if (!isNode(statement) || statement.type !== 'IfStatement') return false;
  const test = nodeField(statement, 'test');
  return (
    isBrowserNegation(test) &&
    isBareReturn(nodeField(statement, 'consequent')) &&
    hasNoAlternate(statement)
  );
}

function isBrowserNegation(node: unknown): boolean {
  if (!isNode(node) || node.type !== 'UnaryExpression' || nodeField(node, 'operator') !== '!')
    return false;
  const argument = nodeField(node, 'argument');
  return (
    isNode(argument) && argument.type === 'Identifier' && nodeField(argument, 'name') === 'browser'
  );
}

function isBareReturn(node: unknown): boolean {
  return isNode(node) && node.type === 'ReturnStatement';
}

function hasNoAlternate(node: AstNode): boolean {
  const alternate = nodeField(node, 'alternate');
  return alternate === undefined || alternate === null;
}

function findDynamicImports(node: AstNode, dominatedByGuard: boolean): DynamicImportInfo[] {
  if (node.type === 'ImportExpression') {
    const source = nodeField(node, 'source');
    const value = isNode(source) && source.type === 'Literal' ? nodeField(source, 'value') : null;
    const specifier = typeof value === 'string' ? value : null;
    return [{ specifier, guardedByEarlyReturn: dominatedByGuard }];
  }

  if (node.type === 'ArrowFunctionExpression') {
    return findDynamicImportsInArrow(node);
  }

  return childNodes(node).flatMap((child) => findDynamicImports(child, dominatedByGuard));
}

function findDynamicImportsInArrow(node: AstNode): DynamicImportInfo[] {
  const body = nodeField(node, 'body');
  if (!isNode(body)) return [];
  if (body.type !== 'BlockStatement') return findDynamicImports(body, false);
  const statements = nodeField(body, 'body');
  const list = Array.isArray(statements) ? statements.filter(isNode) : [];
  const guarded = list[0] !== undefined && isEarlyBrowserReturnGuard(list[0]);
  return list.flatMap((statement) => findDynamicImports(statement, guarded));
}

function collectViolations(statements: readonly AstNode[]): {
  staticValueViolations: string[];
  unguardedDynamicViolations: string[];
  nonLiteralDynamicViolations: string[];
} {
  const staticValueViolations: string[] = [];
  const unguardedDynamicViolations: string[] = [];
  const nonLiteralDynamicViolations: string[] = [];

  for (const statement of statements) {
    const staticImport = staticProtectedImport(statement);
    if (staticImport) staticValueViolations.push(staticImport);
    const dynamic = findDynamicImports(statement, false);
    for (const violation of classifyDynamicImports(dynamic)) {
      if (violation.kind === 'non-literal') nonLiteralDynamicViolations.push(violation.value);
      if (violation.kind === 'unguarded') unguardedDynamicViolations.push(violation.value);
    }
  }

  return { staticValueViolations, unguardedDynamicViolations, nonLiteralDynamicViolations };
}

function staticProtectedImport(statement: AstNode): string | null {
  if (statement.type !== 'ImportDeclaration' || nodeField(statement, 'importKind') === 'type')
    return null;
  const source = nodeField(statement, 'source');
  const specifier = isNode(source) ? nodeField(source, 'value') : undefined;
  return typeof specifier === 'string' && isProtected(specifier) ? specifier : null;
}

type DynamicViolation = { kind: 'non-literal' | 'unguarded'; value: string };

function classifyDynamicImports(imports: readonly DynamicImportInfo[]): DynamicViolation[] {
  const violations: DynamicViolation[] = [];
  for (const { specifier, guardedByEarlyReturn } of imports) {
    if (specifier === null) {
      violations.push({ kind: 'non-literal', value: '<non-literal specifier>' });
    } else if (isProtected(specifier) && !guardedByEarlyReturn) {
      violations.push({ kind: 'unguarded', value: specifier });
    }
  }
  return violations;
}

const SOURCE_PATH = new URL('./markdown-editor.svelte', import.meta.url).pathname;
const source = await Bun.file(SOURCE_PATH)
  .text()
  .catch(() => {
    throw new Error(`[import-boundary] Cannot read ${SOURCE_PATH} — failing hard per plan`);
  });
const svelteAst = parseSvelte(source, SOURCE_PATH);
const instanceBody = scriptStatements(svelteAst, 'instance');
const moduleBody = scriptStatements(svelteAst, 'module');
const { staticValueViolations, unguardedDynamicViolations, nonLiteralDynamicViolations } =
  collectViolations([...moduleBody, ...instanceBody]);

function analyzeFixture(svelteSource: string): ReturnType<typeof collectViolations> {
  const ast = parseSvelte(svelteSource, 'fixture.svelte');
  return collectViolations(scriptStatements(ast, 'instance'));
}

describe('MarkdownEditor import-boundary invariant', () => {
  it('has no static value imports from @milkdown/ or prosemirror-', () => {
    expect(staticValueViolations).toEqual([]);
  });

  it('has no unguarded dynamic imports of @milkdown/ or prosemirror-', () => {
    expect(unguardedDynamicViolations).toEqual([]);
  });

  it('has no non-literal dynamic import specifiers in the script', () => {
    expect(nonLiteralDynamicViolations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Permanent synthetic fixtures — prove the matcher is fail-closed
// These MUST stay in the test; they are the regression coverage for the
// matcher itself, not for the component.
// ---------------------------------------------------------------------------

describe('import-boundary matcher fixtures (fail-closed regression coverage)', () => {
  it('FAILS: static value import from protected package', () => {
    const result = analyzeFixture(
      `<script lang="ts">import { foo } from '@milkdown/kit/ctx';</script><div></div>`,
    );
    expect(result.staticValueViolations).toEqual(['@milkdown/kit/ctx']);
  });

  it('PASSES: type-only import from protected package', () => {
    const result = analyzeFixture(
      `<script lang="ts">import type { Ctx } from '@milkdown/kit/ctx';</script><div></div>`,
    );
    expect(result.staticValueViolations).toEqual([]);
  });

  it('PASSES: guarded dynamic import (early-return domination)', () => {
    const result = analyzeFixture(
      `<script lang="ts">
        $effect(() => {
          if (!browser) return;
          void import('@milkdown/kit/prose/history').then(m => {});
        });
      </script><div></div>`,
    );
    expect(result.unguardedDynamicViolations).toEqual([]);
  });

  it('FAILS: unguarded dynamic import of protected package at top level', () => {
    const result = analyzeFixture(
      `<script lang="ts">
        void import('@milkdown/kit/prose/history').then(m => {});
      </script><div></div>`,
    );
    expect(result.unguardedDynamicViolations).toEqual(['@milkdown/kit/prose/history']);
  });

  it('FAILS: unguarded dynamic import of protected package inside effect (no guard)', () => {
    const result = analyzeFixture(
      `<script lang="ts">
        $effect(() => {
          void import('@milkdown/kit/prose/history').then(m => {});
        });
      </script><div></div>`,
    );
    expect(result.unguardedDynamicViolations).toEqual(['@milkdown/kit/prose/history']);
  });

  it('FAILS: non-literal specifier in dynamic import', () => {
    const result = analyzeFixture(
      `<script lang="ts">
        const pkg = '@milkdown/kit/prose/history';
        $effect(() => {
          if (!browser) return;
          void import(pkg).then(m => {});
        });
      </script><div></div>`,
    );
    expect(result.nonLiteralDynamicViolations).toEqual(['<non-literal specifier>']);
  });

  it('PASSES: dynamic import of a safe (non-protected) package', () => {
    const result = analyzeFixture(
      `<script lang="ts">
        void import('some-safe-package').then(m => {});
      </script><div></div>`,
    );
    expect(result.unguardedDynamicViolations).toEqual([]);
    expect(result.staticValueViolations).toEqual([]);
  });
});
