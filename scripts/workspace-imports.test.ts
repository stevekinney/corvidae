import { describe, expect, test } from 'bun:test';
import { isBuiltin } from 'node:module';
import { join } from 'node:path';
import ts from 'typescript';

const root = join(import.meta.dir, '..');
type Manifest = {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

async function readManifest(path: string): Promise<Manifest> {
  return Bun.file(join(root, path, 'package.json')).json();
}

const formerPackageNames = [
  'bureau',
  'armorer',
  'conversationalist',
  'memory',
  'skills',
  'interoperability',
  'lifecycle',
  '@lostgradient/operative',
  '@lostgradient/weft',
  '@lostgradient/weft-ui',
  '@lostgradient/cinder',
  '@lostgradient/chat',
  '@lostgradient/editor',
  '@lostgradient/markdown',
  '@cinder/testing',
  '@cinder/chat-room-lab',
];

function isFormerPackageName(name: string): boolean {
  return formerPackageNames.some((former) => name === former || name.startsWith(`${former}/`));
}

function externalPackageName(specifier: string): string | undefined {
  if (/^(?:[./$#]|@repo\/|bun(?::|$)|virtual:|file:)/.test(specifier) || isBuiltin(specifier))
    return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function assertExternalDeclaration(
  name: string,
  dependencies: Record<string, string>,
  location: string,
): void {
  const external = externalPackageName(name);
  if (external === undefined) return;
  const typePackage = `@types/${external.replace(/^@/, '').replace('/', '__')}`;
  expect(
    dependencies[external] ?? dependencies[typePackage],
    `${location} imports undeclared ${external}`,
  ).toBeString();
}

function importedPackageNames(source: string, path: string): Set<string> {
  const code = path.endsWith('.svelte')
    ? Array.from(source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g), (match) => match[1]).join(
        '\n',
      )
    : source;
  const tree = ts.createSourceFile(
    path,
    code,
    { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
    false,
  );
  const names = new Set<string>();
  function visit(node: ts.Node): void {
    const specifier = moduleSpecifier(node);
    if (specifier !== undefined) names.add(specifier);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return names;
}

function moduleSpecifier(node: ts.Node): string | undefined {
  const value = moduleSpecifierNode(node);
  return value && ts.isStringLiteralLike(value) ? value.text : undefined;
}

function moduleSpecifierNode(node: ts.Node): ts.Node | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
    return node.argument.literal;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
    return node.moduleReference.expression;
  if (ts.isCallExpression(node) && isModuleLoadingCall(node.expression)) return node.arguments[0];
  return undefined;
}

function isModuleLoadingCall(expression: ts.LeftHandSideExpression): boolean {
  if (expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(expression)) return expression.text === 'require';
  if (!ts.isPropertyAccessExpression(expression)) return false;
  const receiver = expression.expression;
  if (ts.isIdentifier(receiver) && receiver.text === 'Bun') {
    return expression.name.text === 'resolve' || expression.name.text === 'resolveSync';
  }
  if (expression.name.text !== 'resolve') return false;
  return (
    (ts.isIdentifier(receiver) && receiver.text === 'require') ||
    (ts.isMetaProperty(receiver) && receiver.keywordToken === ts.SyntaxKind.ImportKeyword)
  );
}

async function readWorkspaceSources(directory: string) {
  const files = Array.from(
    new Bun.Glob('**/*.{ts,tsx,svelte}').scanSync({ cwd: join(root, directory) }),
  ).filter((file) => !/(^|\/)(node_modules|build|dist|coverage|\.svelte-kit)\//.test(file));
  const pendingFiles = files.entries();
  const sources: { file: string; source: string }[] = [];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (const [position, file] of pendingFiles) {
        const source = await Bun.file(join(root, directory, file)).text();
        sources[position] = { file, source };
      }
    }),
  );
  return sources;
}

describe('workspace imports', () => {
  test('import scanning finds former package names without treating text fixtures as imports', () => {
    const source = `
      import { createConversation } from 'conversationalist';
      export { tool } from 'armorer';
      const runtime = import('@lostgradient/weft/storage');
      const example = "import { fake } from 'bureau';";
    `;
    expect(importedPackageNames(source, 'consumer.ts')).toEqual(
      new Set(['conversationalist', 'armorer', '@lostgradient/weft/storage']),
    );
  });
  test('scans type imports, CommonJS imports and explicit module resolution', () => {
    const source = `
      type Tool = import('armorer').Tool;
      import Memory = require('memory');
      const workflow = require('@lostgradient/weft');
      const lifecycle = require.resolve('lifecycle');
      const editor = import.meta.resolve('@lostgradient/editor');
      const editorSource = Bun.resolveSync('@repo/editor', import.meta.dir);
      const chatSource = await Bun.resolve('@repo/chat', import.meta.dir);
      const ignored = "require('bureau')";
    `;
    expect(importedPackageNames(source, 'consumer.ts')).toEqual(
      new Set([
        'armorer',
        'memory',
        '@lostgradient/weft',
        'lifecycle',
        '@lostgradient/editor',
        '@repo/editor',
        '@repo/chat',
      ]),
    );
  });
  test('finds namespace exports and escaped require names without scanning examples or AMD calls', () => {
    const source = `
      export * as workflow from '@repo/weft';
      const runtime = req\\u0075ire.resolve('@repo/lifecycle');
      const example = "import('@repo/bureau')";
      // require('@repo/memory');
      define(['@repo/skills'], () => {});
      const load = require;
      load('@repo/armorer');
    `;
    expect(importedPackageNames(source, 'consumer.ts')).toEqual(
      new Set(['@repo/weft', '@repo/lifecycle']),
    );
  });
  test('scans each Svelte script block without treating markup as an import', () => {
    const source = `
      <script module>export * as library from '@repo/cinder';</script>
      <script lang="ts">import type { Message } from '@repo/chat';</script>
      <p>require('@repo/bureau')</p>
    `;
    expect(importedPackageNames(source, 'consumer.svelte')).toEqual(
      new Set(['@repo/cinder', '@repo/chat']),
    );
  });
  test('source imports use declared workspace dependencies and the sole public entry point', async () => {
    for (const path of new Bun.Glob('{packages,applications}/*/package.json').scanSync({
      cwd: root,
    })) {
      const directory = path.slice(0, -'/package.json'.length);
      const manifest = await readManifest(directory);
      const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
      for (const { file, source } of await readWorkspaceSources(directory)) {
        expect(source, `${directory}/${file} suppresses TypeScript checking`).not.toMatch(
          /^\s*\/\/\s*@ts-(?:nocheck|ignore)\b/m,
        );
        for (const name of importedPackageNames(source, file)) {
          expect(
            isFormerPackageName(name),
            `${directory}/${file} imports former package ${name}`,
          ).toBe(false);
          assertExternalDeclaration(name, dependencies, `${directory}/${file}`);
          if (!name.startsWith('@repo/')) continue;
          expect(name, `${directory}/${file}`).toMatch(/^@repo\/[^/]+$/);
          if (
            file.startsWith('src/') &&
            !/(^|\/)(?:test|tests|fixtures|__fixtures__|__test-helpers__)\/|(?:\.|-)(?:test|spec|fixture)(?:\.|-)/.test(
              file,
            )
          ) {
            expect(name, `${directory}/${file} imports its own public barrel`).not.toBe(
              manifest.name,
            );
          }
          if (name !== manifest.name) {
            expect(dependencies[name], `${directory}/${file} imports undeclared ${name}`).toBe(
              'workspace:*',
            );
          }
        }
      }
    }
  });
  test('manifests do not retain former package identities', async () => {
    for (const path of new Bun.Glob('{packages,applications}/*/package.json').scanSync({
      cwd: root,
    })) {
      const manifest = await readManifest(path.slice(0, -'/package.json'.length));
      for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
        expect(isFormerPackageName(name), `${manifest.name} declares former package ${name}`).toBe(
          false,
        );
      }
    }
  });
});
