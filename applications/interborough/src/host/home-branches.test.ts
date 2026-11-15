/**
 * COR-2468: the host decides from what its home says it can do (`capabilities`,
 * `deploymentSecrets.writable`) and finds a location's storage or definitions in a table keyed by
 * kind (`locations.ts`). This guard fails when a host file compares anything against the name of a
 * mode or a kind, which is the branch the capabilities and the tables replaced.
 */
import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import ts from 'typescript';

const HOST_DIRECTORY = import.meta.dir;
const FORBIDDEN = new Set(['local', 'remote', 'sqlite', 'postgres', 'directory', 's3']);

/** The files the guard reads: every TypeScript file under the host, but the table and the tests. */
function isGuarded(path: string): boolean {
  const name = basename(path);
  return (
    name !== 'locations.ts' && !name.endsWith('.test.ts') && !name.endsWith('.test-support.ts')
  );
}

function forbiddenLiteral(node: ts.Node): string | undefined {
  return (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    FORBIDDEN.has(node.text)
    ? node.text
    : undefined;
}

/** Each place `source` compares against a forbidden literal, as `<line>: <text>` for a message. */
function findHomeBranches(source: string, fileName = 'source.ts'): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const report = (node: ts.Node): void => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    found.push(`${line + 1}: ${node.getText(file)}`);
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
      (forbiddenLiteral(node.left) !== undefined || forbiddenLiteral(node.right) !== undefined)
    ) {
      report(node);
    }
    if (ts.isCaseClause(node) && forbiddenLiteral(node.expression) !== undefined) report(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('findHomeBranches', () => {
  test('finds a comparison of a property of the home against a mode', () => {
    expect(findHomeBranches(`if (bungalow.mode === 'remote') throw new Error('x');`)).toEqual([
      `1: bungalow.mode === 'remote'`,
    ]);
  });

  test('finds a comparison of a bare name against a mode', () => {
    expect(findHomeBranches(`const mode = read();\nreturn mode === 'remote' ? a : b;`)).toEqual([
      `2: mode === 'remote'`,
    ]);
  });

  test('finds !==, a literal on the left, and a template literal', () => {
    expect(findHomeBranches(`a !== 'local'; 's3' === kind; kind === \`sqlite\`;`)).toHaveLength(3);
  });

  test('finds a case label of a kind', () => {
    expect(
      findHomeBranches(`switch (location.kind) { case 'postgres': return 1; default: return 2; }`),
    ).toEqual([`1: case 'postgres': return 1;`]);
  });

  test('finds each of the six names', () => {
    for (const name of FORBIDDEN) {
      expect(findHomeBranches(`x === '${name}'`)).toHaveLength(1);
    }
  });

  test('leaves alone a literal that is not compared, a comment, and another comparison', () => {
    expect(
      findHomeBranches(
        [
          `const location = { kind: 'sqlite', path };`,
          `// bungalow.mode === 'remote' is what this replaced`,
          `/** if (mode === 'local') */`,
          `const text = "mode === 'remote'";`,
          `if (kind === 'other') return;`,
          `names.includes('local');`,
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});

describe('the host', () => {
  test('compares no home against the name of a mode or a kind outside locations.ts', async () => {
    const offenders: string[] = [];
    let guarded = 0;
    for await (const path of new Glob('**/*.ts').scan({ cwd: HOST_DIRECTORY })) {
      if (!isGuarded(path)) continue;
      guarded += 1;
      const source = await readFile(join(HOST_DIRECTORY, path), 'utf8');
      for (const found of findHomeBranches(source, path)) {
        offenders.push(`${relative(HOST_DIRECTORY, join(HOST_DIRECTORY, path))}:${found}`);
      }
    }
    // The guard reads the host, not an empty directory.
    expect(guarded).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});
