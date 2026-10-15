/**
 * COR-1439 — lets native Node load the workspace's TypeScript source.
 *
 * The signal-shutdown hosts run under `node --import <this file> <host>.ts`,
 * so the signal reaches the host itself rather than a `node --test` runner.
 * Node's own type stripping handles most of the source. Two things it does
 * not handle are fixed here, and nothing else:
 *
 * - Operative, Armorer, and Conversationalist import siblings without a file
 *   extension, which Node's ES module resolver refuses. A relative specifier
 *   that does not resolve is retried as `<specifier>.ts`, then
 *   `<specifier>/index.ts`.
 * - A few files use syntax that type stripping cannot erase (constructor
 *   parameter properties, runtime enums, namespaces). Only those files are
 *   transpiled with the workspace's own TypeScript compiler; every other file
 *   goes to Node unchanged as `module-typescript`.
 *
 * `registerHooks` runs in-thread and synchronously, and none of this calls an
 * experimental API, so the hosts' stderr stays empty.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import type * as TypeScript from 'typescript';

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof TypeScript;

/** A cheap textual screen: only a file that could contain unerasable syntax is parsed. */
const MAY_NEED_TRANSFORM = /\b(?:enum|namespace|module)\s+[\w$]|\bconstructor\s*\(/;

function isDeclared(node: TypeScript.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ??
      false)
  );
}

function needsTransform(path: string, source: string): boolean {
  if (!MAY_NEED_TRANSFORM.test(source)) return false;
  let found = false;
  const visit = (node: TypeScript.Node): void => {
    if (found) return;
    if (
      (ts.isParameter(node) && ts.isParameterPropertyDeclaration(node, node.parent)) ||
      ((ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) && !isDeclared(node))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true));
  return found;
}

function isWorkspaceTypeScript(url: string): boolean {
  return url.startsWith('file:') && url.endsWith('.ts') && !url.includes('/node_modules/');
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const parentURL = context.parentURL;
      if (!specifier.startsWith('.') || parentURL === undefined) throw error;
      for (const suffix of ['.ts', '/index.ts']) {
        const candidate = new URL(`${specifier}${suffix}`, parentURL);
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (!isWorkspaceTypeScript(url)) return nextLoad(url, context);
    const path = fileURLToPath(url);
    const source = readFileSync(path, 'utf8');
    if (!needsTransform(path, source)) {
      return { format: 'module-typescript', source, shortCircuit: true };
    }
    const output = ts.transpileModule(source, {
      fileName: path,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2023,
        verbatimModuleSyntax: true,
      },
    });
    return { format: 'module', source: output.outputText, shortCircuit: true };
  },
});
