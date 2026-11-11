/**
 * COR-1708 — `create-bureau.ts` composes the namespaces and defines none of their methods.
 *
 * Each namespace verb lives in the module that owns it (`tasks/`, `contexts/`, `reviews/`,
 * `schedules/`, `audit/`, the agent catalog), and `create-bureau.ts` hands those modules the
 * private implementations they wrap. A verb defined as a method of an object literal in
 * `create-bureau.ts` would be a namespace method that skipped its module, so this reads the file's
 * syntax tree and refuses one. A composition call, `list: listSessions` or an expression-bodied
 * `receipt: (query) => locateRunCreationReceipt(...)`, only points at an implementation and is not
 * a definition.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';
import ts from 'typescript';

/**
 * Every verb a Bureau namespace exposes: the members of `tasks`, `contexts`, `reviews`,
 * `schedules`, and `audit`, and the operations `agents` gained (`models`).
 * The top-level operations (`ownerOf`, `recovery`, `maintain`, `frames`) belong to the Bureau
 * itself and are not listed.
 */
const NAMESPACE_VERBS: ReadonlySet<string> = new Set([
  // tasks
  'start',
  'detail',
  'get',
  'list',
  'cancel',
  'receipt',
  'workflow',
  'workflows',
  'wait',
  'snapshot',
  'events',
  'subscribeEvents',
  'inspect',
  'respond',
  // contexts
  'delete',
  'signal',
  'input',
  'retract',
  'forgetGrants',
  'inputsDeliveredBy',
  'steer',
  'steering',
  'fork',
  // reviews
  'resolve',
  'pendingOf',
  // schedules
  'create',
  'pause',
  'resume',
  'update',
  'agentName',
  'inputPreview',
  // audit
  'query',
  // agents
  'models',
  'publish',
  'withdraw',
]);

function nameOf(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

/**
 * The namespace verbs that `sourceText` defines as a method (`list() {}`, `async get() {}`) or as
 * a property holding a function with a body (`list: function () {}`, `list: () => { ... }`), with
 * the line each starts on. An expression-bodied arrow is a delegation and is not reported.
 */
function namespaceMethodDefinitions(sourceText: string): string[] {
  const source = ts.createSourceFile('source.ts', sourceText, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const report = (node: ts.Node, verb: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push(`${verb} (line ${line + 1})`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node)) {
      const verb = nameOf(node.name);
      if (verb !== undefined && NAMESPACE_VERBS.has(verb)) report(node, verb);
    } else if (ts.isPropertyAssignment(node)) {
      const verb = nameOf(node.name);
      const value = node.initializer;
      const hasBody =
        ts.isFunctionExpression(value) || (ts.isArrowFunction(value) && ts.isBlock(value.body));
      if (verb !== undefined && NAMESPACE_VERBS.has(verb) && hasBody) report(node, verb);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('namespaceMethodDefinitions', () => {
  it('reports a method, an async method, a function property, and a block-bodied arrow', () => {
    expect(
      namespaceMethodDefinitions(`
        const a = {
          list() { return []; },
          async cancel(id: string) { return id; },
          fork: function () {},
          resolve: async (input: string) => { return input; },
          'pendingOf'(taskId: string) { return taskId; },
        };
      `),
    ).toEqual([
      'list (line 3)',
      'cancel (line 4)',
      'fork (line 5)',
      'resolve (line 6)',
      'pendingOf (line 7)',
    ]);
  });

  it('does not report a composition call or a method that is not a namespace verb', () => {
    expect(
      namespaceMethodDefinitions(`
        const a = createContexts({
          list: listSessions,
          get: getSession,
          receipt: (query) => locateRunCreationReceipt(query),
          events: (type, options) => emitter.events(type, options),
          steer: submitSteeringCommand,
        });
        const b = {
          recovery() { return barrier; },
          frames(listener) { return () => undefined; },
          get lifecycle() { return 'ready'; },
        };
        function listSessions() { return []; }
        interface Shape { list(): void; cancel: () => void }
        type Alias = { start(): void };
      `),
    ).toEqual([]);
  });
});

/**
 * `create-bureau.ts` and every seam its closure moved into `bureau-seams/` (COR-2376),
 * subdirectories included, so code that leaves the file for a seam stays under this guard.
 */
async function compositionFiles(): Promise<string[]> {
  const seams = await readdir(join(import.meta.dir, 'bureau-seams'), { recursive: true });
  return [
    'create-bureau.ts',
    ...seams
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .toSorted()
      .map((name) => join('bureau-seams', name)),
  ];
}

describe('create-bureau.ts and its seams', () => {
  it('scans the seams directory', async () => {
    expect(await compositionFiles()).toContain(join('bureau-seams', 'core.ts'));
  });

  it('defines no namespace method', async () => {
    const found: string[] = [];
    for (const file of await compositionFiles()) {
      const text = await Bun.file(join(import.meta.dir, file)).text();
      found.push(...namespaceMethodDefinitions(text).map((definition) => `${file}: ${definition}`));
    }

    expect(found).toEqual([]);
  });
});
