/**
 * COR-2376 — the construction window. In `constructBureau`, between the hoisted container
 * declarations (the first is `activeRuns`) and the last seam factory call, nothing may `await`, and
 * nothing may call a member a seam factory returns outside a function that runs later.
 *
 * Why it is load-bearing: `resolvedReviewIds` and `invalidApprovalReviewIds` are declared in that
 * window with a callback that calls `stopLazyExpirySweepWhenNoneHeld`, a seam `const` that exists
 * only once its seam factory has returned. The callback is safe because nothing in the window can
 * add an id to either set before the seam block ends. An `await` there would let other work run
 * mid-construction, and an eager call to a seam member would run it before the seam's own
 * dependencies are built. Nothing else enforces it, so this guard reads the syntax.
 */
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'bun:test';
import ts from 'typescript';

const CREATE_BUREAU = join(dirname(import.meta.dir), 'create-bureau.ts');
/** The first hoisted container: the window starts at its declaration. */
const WINDOW_START = 'activeRuns';

function parse(sourceText: string): ts.SourceFile {
  return ts.createSourceFile('source.ts', sourceText, ts.ScriptTarget.Latest, true);
}

/** A function body that does not run when the statement containing it runs. */
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

/** The names a statement of the form `const { a, b: c } = create<Seam><D>(core, peers)` binds. */
function seamMembersOf(statement: ts.Statement): string[] | undefined {
  if (!ts.isVariableStatement(statement)) return undefined;
  const found: string[] = [];
  let isSeamCall = false;
  for (const declaration of statement.declarationList.declarations) {
    const call = declaration.initializer;
    if (
      call === undefined ||
      !ts.isCallExpression(call) ||
      !ts.isIdentifier(call.expression) ||
      !/^create[A-Z]/.test(call.expression.text) ||
      call.arguments.length !== 2 ||
      !ts.isIdentifier(call.arguments[0]!) ||
      call.arguments[0].text !== 'core' ||
      !ts.isIdentifier(call.arguments[1]!) ||
      call.arguments[1].text !== 'peers'
    ) {
      continue;
    }
    isSeamCall = true;
    if (ts.isIdentifier(declaration.name)) found.push(declaration.name.text);
    else
      for (const element of declaration.name.elements)
        if (ts.isBindingElement(element) && ts.isIdentifier(element.name))
          found.push(element.name.text);
  }
  return isSeamCall ? found : undefined;
}

function declaresName(statement: ts.Statement, name: string): boolean {
  return (
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
    )
  );
}

const WHY =
  'a callback of `resolvedReviewIds` or `invalidApprovalReviewIds` could run before `stopLazyExpirySweepWhenNoneHeld` exists';

/**
 * Violations of the construction window in the `constructBureau` of `sourceText`: an `await`, or a
 * call to a name a seam factory returns, in a top-level statement from the declaration of
 * `windowStart` to the last seam factory call, outside the bodies of nested functions.
 */
function constructionWindowViolations(sourceText: string, windowStart = WINDOW_START): string[] {
  const source = parse(sourceText);
  const constructor = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'constructBureau',
  );
  const statements = constructor?.body?.statements;
  if (statements === undefined) throw new Error('create-bureau.ts declares no `constructBureau`');

  const start = statements.findIndex((statement) => declaresName(statement, windowStart));
  if (start === -1) {
    throw new Error(
      `constructBureau declares no \`${windowStart}\`, the first hoisted container: update WINDOW_START in construction-window.test.ts`,
    );
  }
  let end = -1;
  const seamMembers = new Set<string>();
  statements.forEach((statement, index) => {
    const members = seamMembersOf(statement);
    if (members === undefined) return;
    end = index;
    for (const member of members) seamMembers.add(member);
  });
  if (end < start) {
    throw new Error(
      'constructBureau calls no seam factory after the hoisted containers: the construction window is empty, so check this guard still finds `create<Seam>(core, peers)` calls',
    );
  }

  const found: string[] = [];
  const report = (node: ts.Node, message: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push(`line ${line + 1}: ${message}`);
  };
  const visit = (node: ts.Node): void => {
    if (isDeferredBody(node)) return;
    if (ts.isAwaitExpression(node)) {
      report(
        node,
        `\`await\` between the hoisted containers and the end of the seam block: ${WHY}. Move the statement below the seam block, or make it run later (inside a function)`,
      );
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      seamMembers.has(node.expression.text)
    ) {
      report(
        node,
        `\`${node.expression.text}\` is a seam member called while \`constructBureau\` is still building its seams: ${WHY}. Move the statement below the seam block, or make the reference lazy (call it inside a function that runs later)`,
      );
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of statements.slice(start, end + 1)) visit(statement);
  return found;
}

describe('constructionWindowViolations', () => {
  const frame = (middle: string, seamTail = ''): string => `
    async function constructBureau(given) {
      const before = await load();
      const activeRuns = new Set();
      ${middle}
      const core = {};
      const peers = {};
      const { first, second: renamed } = createFirst<D>(core, peers);
      const { last } = createLast<D>(core, peers);
      ${seamTail}
    }
  `;

  it('allows allocations, callbacks, getters and calls below the seam block', () => {
    expect(
      constructionWindowViolations(
        frame(
          `
          const ids = new NotifyingReviewIdSet(() => renamed());
          const later = async () => { await first(); last(); };
          const holder = { get live() { return last(); }, run() { return first(); } };
          const registry = new Map();
        `,
          `
          await first();
          last();
          renamed();
        `,
        ),
      ),
    ).toEqual([]);
  });

  it('ignores an await above the first container', () => {
    expect(constructionWindowViolations(frame(''))).toEqual([]);
  });

  it('reports an await inside the window, in a nested expression and an if', () => {
    const violations = constructionWindowViolations(
      frame(`
        const settled = await settle();
        if (flag) { await other(); }
      `),
    );
    expect(violations).toEqual([
      expect.stringContaining('line 6: `await` between the hoisted containers'),
      expect.stringContaining('line 7: `await` between the hoisted containers'),
    ]);
    expect(violations[0]).toContain('Move the statement below the seam block');
    expect(violations[0]).toContain('make it run later');
  });

  it('reports an eager call to a seam member, and one in an immediately invoked function', () => {
    const violations = constructionWindowViolations(
      frame(`
        const early = renamed();
        const hidden = (() => last())();
      `),
    );
    expect(violations).toEqual([
      expect.stringContaining('line 6: `renamed` is a seam member called'),
      expect.stringContaining('line 7: `last` is a seam member called'),
    ]);
    expect(violations[0]).toContain('make the reference lazy');
    expect(violations[0]).toContain('`stopLazyExpirySweepWhenNoneHeld`');
  });

  it('reports a call between two seam factory calls', () => {
    expect(
      constructionWindowViolations(`
        async function constructBureau() {
          const activeRuns = new Set();
          const core = {};
          const peers = {};
          const { first } = createFirst<D>(core, peers);
          first();
          const { last } = createLast<D>(core, peers);
        }
      `),
    ).toEqual([expect.stringContaining('line 7: `first` is a seam member called')]);
  });

  it('fails loudly when it cannot find the window', () => {
    expect(() => constructionWindowViolations('function constructBureau() {}')).toThrow(
      'declares no `activeRuns`',
    );
    expect(() =>
      constructionWindowViolations('function constructBureau() { const activeRuns = 1; }'),
    ).toThrow('calls no seam factory');
  });
});

describe('the construction window of create-bureau.ts', () => {
  it('has no await and no eager call to a seam member', async () => {
    expect(constructionWindowViolations(await Bun.file(CREATE_BUREAU).text())).toEqual([]);
  });
});
