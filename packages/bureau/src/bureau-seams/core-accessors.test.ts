/**
 * COR-2376 — the core's plain members are values fixed before the core exists, and everything else
 * is read live through an accessor. Two mistakes would compile and run silently, so this guard
 * reads the syntax:
 *
 * - a `let` written as a shorthand member of the `core` literal in `constructBureau` copies its
 *   value once, so a later assignment is never seen. Only `options` may be one, because nothing
 *   assigns it after the core is built;
 * - a seam that destructures an accessor from `core` freezes the value it had when the factory ran.
 */
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'bun:test';
import ts from 'typescript';

const SEAMS_DIRECTORY = import.meta.dir;
const CREATE_BUREAU = join(dirname(SEAMS_DIRECTORY), 'create-bureau.ts');
/** The one `let` that may be a plain member: its last assignment is above the core literal. */
const PLAIN_LET = 'options';

function parse(sourceText: string): ts.SourceFile {
  return ts.createSourceFile('source.ts', sourceText, ts.ScriptTarget.Latest, true);
}

/** `constructBureau` and the `const core = { ... }` literal at its top level. */
function coreLiteralOf(source: ts.SourceFile): {
  body: ts.Block;
  parameters: readonly ts.ParameterDeclaration[];
  statement: ts.VariableStatement;
  literal: ts.ObjectLiteralExpression;
} {
  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name?.text !== 'constructBureau')
      continue;
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
  throw new Error('constructBureau declares no `const core = { ... }` literal');
}

/** How each top-level binding of `constructBureau` is declared. */
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
function plainMembers(sourceText: string): Set<string> {
  const { literal } = coreLiteralOf(parse(sourceText));
  return new Set(
    literal.properties.filter(ts.isShorthandPropertyAssignment).map((member) => member.name.text),
  );
}

/** Shorthand members of the `core` literal that are not fixed values, each with what to do. */
function shorthandViolations(sourceText: string): string[] {
  const source = parse(sourceText);
  const { body, parameters, statement, literal } = coreLiteralOf(source);
  const kinds = bindingKinds(body, parameters);
  const found: string[] = [];
  for (const member of literal.properties) {
    if (!ts.isShorthandPropertyAssignment(member)) continue;
    const name = member.name.text;
    const kind = kinds.get(name);
    if (kind === 'const' || kind === 'function' || (kind === 'let' && name === PLAIN_LET)) continue;
    found.push(
      `\`${name}\` is ${kind === undefined ? 'not a top-level binding of constructBureau' : `a ${kind}`}: write it in the core literal as a getter (\`get ${name}() { return ${name}; }\`), and add a setter only if a seam assigns it`,
    );
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left) &&
      node.left.text === PLAIN_LET &&
      node.getStart(source) > statement.getEnd()
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push(
        `\`${PLAIN_LET}\` is assigned below the core literal (line ${line + 1}): move the assignment above it, or make \`${PLAIN_LET}\` a getter in the core literal`,
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

describe('the core of create-bureau.ts', () => {
  it('lists only fixed values as shorthand members', async () => {
    expect(shorthandViolations(await Bun.file(CREATE_BUREAU).text())).toEqual([]);
  });

  it('is never destructured for an accessor by a seam', async () => {
    const plain = plainMembers(await Bun.file(CREATE_BUREAU).text());
    expect(plain).toContain('runtime');

    const entries = await readdir(SEAMS_DIRECTORY, { recursive: true });
    const found: string[] = [];
    for (const file of entries
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .toSorted()) {
      const text = await Bun.file(join(SEAMS_DIRECTORY, file)).text();
      found.push(...destructuredAccessors(text, plain).map((violation) => `${file}: ${violation}`));
    }

    expect(found).toEqual([]);
  });
});
