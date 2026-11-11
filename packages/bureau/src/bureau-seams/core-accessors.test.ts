/**
 * COR-2376 — the core's plain members are values fixed before the core exists, and everything else
 * is read live through an accessor. Two mistakes would compile and run silently, so this guard
 * reads the syntax:
 *
 * - a `let` (or a parameter) written as a shorthand member of the `core` literal in a parent
 *   (`constructBureau`, `buildRuntimeComposition`) copies its value once, so a later assignment is
 *   never seen. Only the names a family lists may be one, because nothing assigns them after the
 *   core is built;
 * - a seam that destructures an accessor from `core` freezes the value it had when the factory ran;
 * - a seam factory that reads `peers`, or `core.<accessor>`, while it runs (outside the functions it
 *   returns) reads a binding its parent has not initialized yet, or freezes the value it has.
 */
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'bun:test';
import ts from 'typescript';

const SEAMS_DIRECTORY = import.meta.dir;
const SOURCE_DIRECTORY = dirname(SEAMS_DIRECTORY);

/** A parent function, the file it lives in, and the directory its seams were cut out into. */
interface Family {
  readonly parent: string;
  readonly parentFunction: string;
  readonly seams: string;
  /** The `let`s and parameters that may be plain members: each is last assigned above the core. */
  readonly plainLets: readonly string[];
  /** A plain member the core must list, so a parse that finds the wrong literal fails. */
  readonly knownPlain: string;
}

const FAMILIES: readonly Family[] = [
  {
    parent: join(SOURCE_DIRECTORY, 'create-bureau.ts'),
    parentFunction: 'constructBureau',
    seams: SEAMS_DIRECTORY,
    plainLets: ['options'],
    knownPlain: 'runtime',
  },
  {
    parent: join(SOURCE_DIRECTORY, 'runtime-composition.ts'),
    parentFunction: 'buildRuntimeComposition',
    seams: join(SOURCE_DIRECTORY, 'composition-seams'),
    // `options` is a parameter; `kv`, `durable` and `effectiveStorageIsPersistent` are `let`s
    // assigned only while storage and the durable engine are built, above the core literal.
    plainLets: ['options', 'kv', 'durable', 'effectiveStorageIsPersistent'],
    knownPlain: 'durableStorage',
  },
];

function parse(sourceText: string): ts.SourceFile {
  return ts.createSourceFile('source.ts', sourceText, ts.ScriptTarget.Latest, true);
}

/** `parentFunction` and the `const core = { ... }` literal at its top level. */
function coreLiteralOf(
  source: ts.SourceFile,
  parentFunction = 'constructBureau',
): {
  body: ts.Block;
  parameters: readonly ts.ParameterDeclaration[];
  statement: ts.VariableStatement;
  literal: ts.ObjectLiteralExpression;
} {
  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name?.text !== parentFunction) continue;
    const body = statement.body;
    if (body === undefined) break;
    for (const inner of body.statements) {
      if (!ts.isVariableStatement(inner)) continue;
      for (const declaration of inner.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === 'core' &&
          declaration.initializer !== undefined &&
          ts.isObjectLiteralExpression(declaration.initializer)
        ) {
          return {
            body,
            parameters: statement.parameters,
            statement: inner,
            literal: declaration.initializer,
          };
        }
      }
    }
  }
  throw new Error(`${parentFunction} declares no \`const core = { ... }\` literal`);
}

/** How each top-level binding of a parent function is declared. */
function bindingKinds(
  body: ts.Block,
  parameters: readonly ts.ParameterDeclaration[],
): Map<string, 'const' | 'let' | 'function' | 'parameter'> {
  const kinds = new Map<string, 'const' | 'let' | 'function' | 'parameter'>();
  for (const parameter of parameters)
    if (ts.isIdentifier(parameter.name)) kinds.set(parameter.name.text, 'parameter');
  for (const statement of body.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      kinds.set(statement.name.text, 'function');
    } else if (ts.isVariableStatement(statement)) {
      const kind = statement.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'let';
      for (const declaration of statement.declarationList.declarations) {
        const names = ts.isIdentifier(declaration.name)
          ? [declaration.name]
          : declaration.name.elements.flatMap((element) =>
              ts.isBindingElement(element) && ts.isIdentifier(element.name) ? [element.name] : [],
            );
        for (const name of names) kinds.set(name.text, kind);
      }
    }
  }
  return kinds;
}

/** The names the `core` literal of `sourceText` lists as shorthand (plain) members. */
function plainMembers(sourceText: string, parentFunction = 'constructBureau'): Set<string> {
  const { literal } = coreLiteralOf(parse(sourceText), parentFunction);
  return new Set(
    literal.properties.filter(ts.isShorthandPropertyAssignment).map((member) => member.name.text),
  );
}

/** Shorthand members of the `core` literal that are not fixed values, each with what to do. */
function shorthandViolations(
  sourceText: string,
  parentFunction = 'constructBureau',
  plainLets: readonly string[] = ['options'],
): string[] {
  const source = parse(sourceText);
  const { body, parameters, statement, literal } = coreLiteralOf(source, parentFunction);
  const kinds = bindingKinds(body, parameters);
  const found: string[] = [];
  for (const member of literal.properties) {
    if (!ts.isShorthandPropertyAssignment(member)) continue;
    const name = member.name.text;
    const kind = kinds.get(name);
    if (
      kind === 'const' ||
      kind === 'function' ||
      ((kind === 'let' || kind === 'parameter') && plainLets.includes(name))
    )
      continue;
    found.push(
      `\`${name}\` is ${kind === undefined ? `not a top-level binding of ${parentFunction}` : `a ${kind}`}: write it in the core literal as a getter (\`get ${name}() { return ${name}; }\`), and add a setter only if a seam assigns it`,
    );
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left) &&
      plainLets.includes(node.left.text) &&
      node.getStart(source) > statement.getEnd()
    ) {
      const name = node.left.text;
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push(
        `\`${name}\` is assigned below the core literal (line ${line + 1}): move the assignment above it, or make \`${name}\` a getter in the core literal`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/** The members `sourceText`, a seam file, destructures from `core` that are not plain members. */
function destructuredAccessors(sourceText: string, plain: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined &&
      ts.isIdentifier(node.initializer) &&
      node.initializer.text === 'core'
    ) {
      for (const element of node.name.elements) {
        const property = element.propertyName ?? element.name;
        const name = ts.isIdentifier(property) ? property.text : property.getText();
        if (!plain.has(name)) {
          found.push(
            `\`${name}\` is an accessor of the core: read \`core.${name}\` where it is used instead of destructuring it`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(sourceText));
  return found;
}

/** A function whose body is not run when the enclosing factory runs (an IIFE is handled apart). */
function isDeferredBody(node: ts.Node): boolean {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isClassLike(node)
  ) {
    const parent = node.parent;
    const invoked =
      (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
      ((ts.isCallExpression(parent) && parent.expression === node) ||
        (ts.isParenthesizedExpression(parent) &&
          ts.isCallExpression(parent.parent) &&
          parent.parent.expression === parent));
    return !invoked;
  }
  return false;
}

/**
 * What a seam factory in `sourceText` reads while it runs: any use of `peers`, and `core.<name>`
 * for a name that is not a plain member. "While it runs" is the statements of the factory body,
 * not the bodies of the functions, accessors and classes it defines, which run later.
 */
function topLevelReads(sourceText: string, plain: ReadonlySet<string>): string[] {
  const source = parse(sourceText);
  const found: string[] = [];
  const report = (node: ts.Node, message: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push(`line ${line + 1}: ${message}`);
  };
  const visit = (node: ts.Node): void => {
    if (isDeferredBody(node)) return;
    if (ts.isIdentifier(node) && node.text === 'peers') {
      const parent = node.parent;
      const isName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isBindingElement(parent) && parent.propertyName === node);
      if (!isName) {
        report(
          node,
          '`peers` is read while the factory runs, before `constructBureau` has defined the peer: read `peers.<name>` inside the function that calls it',
        );
      }
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'core'
    ) {
      const member = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression;
      const name = ts.isIdentifier(member) ? member.text : member.getText(source).slice(1, -1);
      if (!plain.has(name)) {
        report(
          node,
          `\`core.${name}\` is an accessor read while the factory runs, which freezes it or reads it before it exists: read it inside the function that uses it`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.body === undefined) continue;
    if (!statement.parameters.some((parameter) => parameter.name.getText(source) === 'core'))
      continue;
    for (const inner of statement.body.statements) visit(inner);
  }
  return found;
}

describe('shorthandViolations', () => {
  it('reports a shorthand let, an unknown name, and an assignment to options below the core', () => {
    expect(
      shorthandViolations(`
        async function constructBureau(given) {
          let options = given;
          options = { ...options };
          const store = 1;
          function diagnose() {}
          let settings;
          const core = { options, store, diagnose, settings, missing, get late() { return late; } };
          options = {};
          const late = 2;
        }
      `),
    ).toEqual([
      '`settings` is a let: write it in the core literal as a getter (`get settings() { return settings; }`), and add a setter only if a seam assigns it',
      '`missing` is not a top-level binding of constructBureau: write it in the core literal as a getter (`get missing() { return missing; }`), and add a setter only if a seam assigns it',
      '`options` is assigned below the core literal (line 9): move the assignment above it, or make `options` a getter in the core literal',
    ]);
  });
});

describe('destructuredAccessors', () => {
  it('reports an accessor destructured from core and allows a plain member', () => {
    expect(
      destructuredAccessors(
        `
          function createSeam(core, peers) {
            const { runtime, hooksInstance: hooks } = core;
            const { store } = peers;
          }
        `,
        new Set(['runtime', 'store']),
      ),
    ).toEqual([
      '`hooksInstance` is an accessor of the core: read `core.hooksInstance` where it is used instead of destructuring it',
    ]);
  });
});

describe('topLevelReads', () => {
  const plain = new Set(['runtime', 'store']);

  it('reports peers and core accessors read while the factory runs', () => {
    expect(
      topLevelReads(
        `
          export function createSeam(core, peers) {
            const { runtime } = core;
            const { stop } = peers;
            const stopNow = peers.stop;
            const frozen = core.hooksInstance;
            const alsoFrozen = core['tasks'];
            const registered = register({ stop: peers.stop });
            return {};
          }
        `,
        plain,
      ),
    ).toEqual([
      expect.stringContaining('line 4: `peers` is read while the factory runs'),
      expect.stringContaining('line 5: `peers` is read while the factory runs'),
      'line 6: `core.hooksInstance` is an accessor read while the factory runs, which freezes it or reads it before it exists: read it inside the function that uses it',
      'line 7: `core.tasks` is an accessor read while the factory runs, which freezes it or reads it before it exists: read it inside the function that uses it',
      expect.stringContaining('line 8: `peers` is read while the factory runs'),
    ]);
  });

  it('allows plain members, and anything read inside a function the factory defines', () => {
    expect(
      topLevelReads(
        `
          export function createSeam(core, peers) {
            const { runtime, store } = core;
            let pending;
            async function work() {
              await peers.stop();
              return core.hooksInstance;
            }
            const run = () => peers.stop(core.tasks);
            const handle = { get live() { return core.tasks; }, stop: () => peers.stop() };
            class Holder { field = core.tasks; method() { return peers.stop; } }
            const unrelated = other.peers.stop;
            return { work, run, handle, runtime, store };
          }
          function notAFactory(value) {
            return peers.stop(value.hooksInstance);
          }
        `,
        plain,
      ),
    ).toEqual([]);
  });

  it('reads an immediately invoked function as top level', () => {
    expect(
      topLevelReads(
        `
          export function createSeam(core, peers) {
            const value = (() => core.tasks)();
            const other = (function () { return peers.stop; })();
          }
        `,
        plain,
      ),
    ).toEqual([
      expect.stringContaining('line 3: `core.tasks`'),
      expect.stringContaining('line 4: `peers` is read'),
    ]);
  });
});

describe('shorthandViolations with a family of plain lets and parameters', () => {
  it('allows the listed lets and parameters, and reports an assignment to one below the core', () => {
    expect(
      shorthandViolations(
        `
          async function buildRuntimeComposition(options, readiness) {
            let kv;
            kv = 1;
            let open = false;
            const core = { options, kv, readiness, open };
            kv = 2;
          }
        `,
        'buildRuntimeComposition',
        ['options', 'kv'],
      ),
    ).toEqual([
      expect.stringContaining(
        '`readiness` is a parameter: write it in the core literal as a getter',
      ),
      expect.stringContaining('`open` is a let: write it in the core literal as a getter'),
      '`kv` is assigned below the core literal (line 7): move the assignment above it, or make `kv` a getter in the core literal',
    ]);
  });
});

/** Every non-test `.ts` file under `seams`, as a path relative to it. */
async function seamFiles(seams: string): Promise<string[]> {
  const entries = await readdir(seams, { recursive: true });
  return entries.filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).toSorted();
}

/** Whether `sourceText` declares a top-level function with a `core` parameter: a seam factory. */
function declaresFactory(sourceText: string): boolean {
  const source = parse(sourceText);
  return source.statements.some(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.parameters.some((parameter) => parameter.name.getText(source) === 'core'),
  );
}

for (const family of FAMILIES) {
  describe(`the core of ${family.parentFunction}`, () => {
    it('lists only fixed values as shorthand members', async () => {
      expect(
        shorthandViolations(
          await Bun.file(family.parent).text(),
          family.parentFunction,
          family.plainLets,
        ),
      ).toEqual([]);
    });

    it('has seams, each with a factory this guard reads', async () => {
      const files = await seamFiles(family.seams);
      const seams = files.filter((file) => file !== 'core.ts');
      // A guard over a directory with no seam, or a seam it cannot read, would pass silently.
      expect(seams.length).toBeGreaterThan(0);
      const withoutFactory: string[] = [];
      for (const file of seams) {
        if (!declaresFactory(await Bun.file(join(family.seams, file)).text()))
          withoutFactory.push(file);
      }
      expect(withoutFactory).toEqual([]);
    });

    it('is never destructured for an accessor by a seam', async () => {
      const plain = plainMembers(await Bun.file(family.parent).text(), family.parentFunction);
      expect(plain).toContain(family.knownPlain);

      const found: string[] = [];
      for (const file of await seamFiles(family.seams)) {
        const text = await Bun.file(join(family.seams, file)).text();
        found.push(
          ...destructuredAccessors(text, plain).map((violation) => `${file}: ${violation}`),
        );
      }

      expect(found).toEqual([]);
    });

    it('never reads `peers` or a core accessor while a seam factory runs', async () => {
      const plain = plainMembers(await Bun.file(family.parent).text(), family.parentFunction);
      const found: string[] = [];
      for (const file of await seamFiles(family.seams)) {
        const text = await Bun.file(join(family.seams, file)).text();
        found.push(...topLevelReads(text, plain).map((violation) => `${file}: ${violation}`));
      }

      expect(found).toEqual([]);
    });
  });
}
