/**
 * A playground test bounds a wait on a real gate process only by the uniform hang guard.
 *
 * The static gate's tests run their processes at module scope, where Bun applies no per-test
 * budget, yet two of them still raced each gate against a few seconds of wall-clock time, a bound
 * left from when every case had to finish inside Bun's 5 s. A healthy gate took 0.7 s at a load
 * average of 28 and 23 s at 290, so whichever case was on the clock during a busy batch validate
 * failed, and it passed alone. `spawnWithHangGuard` and `outcomeOf` already turn a process that
 * never ends into a failure, on awake time, so a shorter bound measures only the host.
 *
 * The rule, checked on every `*.test.ts` under `scripts/` and `src/`: the bound passed to
 * `exitedWithin` or `waitUntil` (their second argument), and a `graceMilliseconds` handed to
 * `interruptRunner`, is `HANG_GUARD_MILLISECONDS` or a `const` declared in the file as exactly
 * that. A bound on something other than a real process, such as a stub whose exit never settles,
 * carries a `// wait-bound: <reason>` comment of at least 20 characters directly above its line.
 *
 * Blind spots: a bound reached through a wrapper the file declares itself (a local `watchdog`), a
 * name imported from another module, or a stand-in's `--wait-milliseconds` argument.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';

const PLAYGROUND = join(import.meta.dirname, '..');
const BOUNDED_CALLS = new Set(['exitedWithin', 'waitUntil']);
const HANG_GUARD = 'HANG_GUARD_MILLISECONDS';
const EXEMPTION = /\/\/ wait-bound: (.{20,})$/;

/** The names a file declares as `const NAME = HANG_GUARD_MILLISECONDS`. */
function hangGuardNames(source: ts.SourceFile): Set<string> {
  const names = new Set([HANG_GUARD]);
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.Const) !== 0 &&
      node.declarations.length > 0
    ) {
      for (const declaration of node.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer !== undefined &&
          ts.isIdentifier(declaration.initializer) &&
          declaration.initializer.text === HANG_GUARD
        ) {
          names.add(declaration.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** Each bound in `text` that is not the hang guard, as `<path>:<line>: <bound>`. */
function shortWaitBounds(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const allowed = hangGuardNames(source);
  const lines = text.split('\n');
  const findings: string[] = [];
  const check = (bound: ts.Expression): void => {
    if (ts.isIdentifier(bound) && allowed.has(bound.text)) return;
    const line = source.getLineAndCharacterOfPosition(bound.getStart(source)).line;
    if (EXEMPTION.test(lines[line - 1]?.trim() ?? '')) return;
    findings.push(`${path}:${line + 1}: ${bound.getText(source)}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const [, second] = node.arguments;
      if (BOUNDED_CALLS.has(node.expression.text) && second !== undefined) check(second);
      if (node.expression.text === 'interruptRunner') {
        for (const argument of node.arguments) {
          if (!ts.isObjectLiteralExpression(argument)) continue;
          for (const property of argument.properties) {
            if (
              ts.isPropertyAssignment(property) &&
              ts.isIdentifier(property.name) &&
              property.name.text === 'graceMilliseconds'
            ) {
              check(property.initializer);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

describe('waits on gate processes in playground tests', () => {
  it('are bounded only by the hang guard', async () => {
    const findings: string[] = [];
    for (const directory of ['scripts', 'src']) {
      for await (const path of new Bun.Glob('**/*.test.ts').scan({
        cwd: join(PLAYGROUND, directory),
      })) {
        const absolute = join(PLAYGROUND, directory, path);
        findings.push(
          ...shortWaitBounds(relative(PLAYGROUND, absolute), readFileSync(absolute, 'utf8')),
        );
      }
    }

    expect(findings).toEqual([]);
  });

  it('reports a literal, a literal-bound constant, and a literal grace', () => {
    const source = [
      'const WAIT = 4_000;',
      'await exitedWithin(gate, 4_500);',
      'await waitUntil(ready, WAIT, "ready");',
      'await interruptRunner(gate, marker, { graceMilliseconds: 1_000 });',
    ].join('\n');

    expect(shortWaitBounds('example.test.ts', source)).toEqual([
      'example.test.ts:2: 4_500',
      'example.test.ts:3: WAIT',
      'example.test.ts:4: 1_000',
    ]);
  });

  it('accepts the hang guard, a constant equal to it, and an exempted stub bound', () => {
    const source = [
      'const WAIT = HANG_GUARD_MILLISECONDS;',
      'await exitedWithin(gate, HANG_GUARD_MILLISECONDS);',
      'await waitUntil(ready, WAIT, "ready");',
      '// wait-bound: the stub never exits, so only the bound is under test',
      'await interruptRunner(stub, undefined, { graceMilliseconds: 200 });',
    ].join('\n');

    expect(shortWaitBounds('example.test.ts', source)).toEqual([]);
  });

  it('does not accept a short exemption reason', () => {
    const source = ['// wait-bound: stub', 'await exitedWithin(gate, 200);'].join('\n');

    expect(shortWaitBounds('example.test.ts', source)).toEqual(['example.test.ts:2: 200']);
  });
});
