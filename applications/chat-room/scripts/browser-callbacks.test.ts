import { expect, test } from 'bun:test';
import { join } from 'node:path';
import ts from 'typescript';

const browserMethods = new Set(['evaluate', 'evaluateAll', 'waitForFunction', 'addInitScript']);

// Playwright serializes callbacks into another process. A refactor that moves
// a helper outside that callback still typechecks, but cannot work in a browser.
function capturedBindings(sources: ReadonlyMap<string, string>): string[] {
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, types: [] };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (filename) => {
    const source = sources.get(filename);
    return source === undefined
      ? undefined
      : ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  };
  const program = ts.createProgram([...sources.keys()], options, host);
  const checker = program.getTypeChecker();
  const captures = new Set<string>();

  for (const source of program.getSourceFiles()) {
    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        browserMethods.has(node.expression.name.text)
      ) {
        const callback = node.arguments[0];
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
          const { pos: callbackStart, end: callbackEnd } = callback;
          function inspect(reference: ts.Node): void {
            if (ts.isTypeNode(reference)) return;
            if (
              ts.isIdentifier(reference) &&
              !(
                ts.isPropertyAccessExpression(reference.parent) &&
                reference.parent.name === reference
              )
            ) {
              const symbol = ts.isShorthandPropertyAssignment(reference.parent)
                ? checker.getShorthandAssignmentValueSymbol(reference.parent)
                : checker.getSymbolAtLocation(reference);
              const external = symbol?.declarations?.some((declaration) => {
                if (declaration.getSourceFile() !== source) return false;
                if (declaration.pos >= callbackStart && declaration.end <= callbackEnd)
                  return false;
                // Type-only imports can share a name with a browser global (Request).
                if (ts.isImportSpecifier(declaration)) {
                  return !declaration.isTypeOnly && !declaration.parent.parent.isTypeOnly;
                }
                if (ts.isImportClause(declaration)) return !declaration.isTypeOnly;
                return true;
              });
              if (external) {
                const line = source.getLineAndCharacterOfPosition(reference.getStart()).line + 1;
                captures.add(`${source.fileName}:${line}: ${reference.text}`);
              }
            }
            ts.forEachChild(reference, inspect);
          }
          inspect(callback);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return [...captures].toSorted();
}

function inspectFixture(source: string): string[] {
  return capturedBindings(new Map([['/browser-callback-fixture.ts', source]]));
}

test('browser callbacks reject extracted helpers, constants, imports and enclosing test state', () => {
  const captures = inspectFixture(`
    import { helper } from './helper';
    const constant = 'value';
    function selectValue(element: Element) { return element.tagName; }
    function testBody() {
      const local = 1;
      page.evaluate((element) => ({ constant, local, value: selectValue(element), helper: helper() }));
    }
  `);
  expect(captures.map((capture) => capture.split(': ').at(-1))).toEqual([
    'constant',
    'helper',
    'local',
    'selectValue',
  ]);
});

test('browser callbacks allow local helpers, explicit arguments, types and browser globals', () => {
  expect(
    inspectFixture(`
    import type { Request } from '@playwright/test';
    const value = 'runner value';
    page.evaluate((value: string) => {
      function readStyle(element: Element) { return getComputedStyle(element).color; }
      return { value, color: readStyle(document.body), request: new Request('/'), label: value };
    }, value);
  `),
  ).toEqual([]);
});

test('shadowing in a nested scope cannot conceal an outer capture', () => {
  expect(
    inspectFixture(`
    const value = 'outside';
    page.evaluate(() => {
      { const value = 'inside'; console.log(value); }
      return value;
    });
  `),
  ).toEqual(['/browser-callback-fixture.ts:5: value']);
});

test('application browser callbacks keep their runtime bindings in the browser', async () => {
  const application = join(import.meta.dir, '..');
  const files = new Bun.Glob('{src,scripts}/**/*.ts').scanSync({ cwd: application });
  const sources = new Map<string, string>();
  for (const file of files) {
    const filename = join(application, file);
    sources.set(filename, await Bun.file(filename).text());
  }
  expect(capturedBindings(sources)).toEqual([]);
});
