import { $ } from 'bun';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import ts from 'typescript';
import { z } from 'zod';
import { catalog } from '../package.json';
import { libraryManifests, releaseEntries } from './agent-library-release-entries.ts';

const repository = resolve(import.meta.dir, '..');
const { values } = parseArgs({
  options: {
    package: { type: 'string' },
    version: { type: 'string' },
    'armorer-version': { type: 'string' },
    outdir: { type: 'string' },
  },
});
const versionSchema = z
  .string()
  .refine((version) => !version.includes('+') && Bun.semver.satisfies(version, version));
const library = z.enum(['armorer', 'bungalow', 'conversationalist']).parse(values.package);
const version = versionSchema.parse(values.version);
const armorerVersion =
  library === 'conversationalist' ? versionSchema.parse(values['armorer-version']) : undefined;
const workspace = join(repository, 'packages', library);
const output = resolve(z.string().min(1).parse(values.outdir));
const privateEntries = new Map([
  ['@lostgradient/cryptography', join(repository, 'packages/cryptography/src/index.ts')],
  ['@lostgradient/lifecycle', join(repository, 'packages/lifecycle/src/index.ts')],
]);

const entries = new Map(
  Object.entries(releaseEntries[library]).map(([key, entry]) => [key, resolve(workspace, entry)]),
);
const workspaceManifest = libraryManifests[library];
const packageName = workspaceManifest.name;
const declaredDependencies = new Map(
  Object.entries({
    ...workspaceManifest.devDependencies,
    ...('dependencies' in workspaceManifest ? workspaceManifest.dependencies : {}),
  }),
);
const externalDependencies = new Set<string>();
const pending = new Set(entries.values());
const catalogVersions = new Map(Object.entries(catalog));

function releasePath(source: string): string {
  const [owner, sourceDirectory, ...parts] = relative(join(repository, 'packages'), source).split(
    '/',
  );
  if (
    sourceDirectory !== 'src' ||
    owner === undefined ||
    ![library, 'cryptography', 'lifecycle'].includes(owner) ||
    !source.endsWith('.ts')
  ) {
    throw new Error(`Unexpected library source: ${source}`);
  }
  return join('dist', ...(owner === library ? [] : ['internal', owner]), ...parts).replace(
    /\.ts$/,
    '',
  );
}

function moduleReferences(file: ts.SourceFile): ts.StringLiteralLike[] {
  const result: ts.StringLiteralLike[] = [];
  function visit(node: ts.Node): void {
    let target: ts.Node | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      target = node.moduleSpecifier;
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      target = node.argument.literal;
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      target = node.arguments[0];
      if (!target || !ts.isStringLiteralLike(target)) {
        throw new Error(`Nonliteral dynamic import in ${file.fileName}`);
      }
    }
    if (target && ts.isStringLiteralLike(target)) result.push(target);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return result;
}

function rewriteModules(code: string, source: string): string {
  const file = ts.createSourceFile(source, code, ts.ScriptTarget.ESNext, true);
  for (const reference of moduleReferences(file).toReversed()) {
    const specifier = reference.text;
    const resolved = specifier.startsWith('.')
      ? Bun.resolveSync(specifier, dirname(source))
      : privateEntries.get(specifier);
    if (resolved !== undefined) {
      pending.add(resolved);
      const path = relative(dirname(releasePath(source)), releasePath(resolved)) + '.js';
      const target = path.startsWith('../') ? path : './' + path;
      code =
        code.slice(0, reference.getStart(file)) +
        JSON.stringify(target) +
        code.slice(reference.end);
    } else if (!isBuiltin(specifier) && !(library === 'bungalow' && specifier === 'bun:test')) {
      const name = specifier
        .split('/')
        .slice(0, specifier.startsWith('@') ? 2 : 1)
        .join('/');
      externalDependencies.add(name);
    }
  }
  return code;
}

function dependencyVersion(name: string): string {
  if (name === 'armorer' && armorerVersion) return armorerVersion;
  const declared = declaredDependencies.get(name);
  const resolved = declared === 'catalog:' ? catalogVersions.get(name) : declared;
  if (!resolved || resolved.startsWith('workspace:')) {
    throw new Error(`No public dependency version for ${name}`);
  }
  return resolved;
}

const declarationBuild = await $`bun run --cwd ${workspace} types`.quiet().nothrow();
process.stderr.write(declarationBuild.stdout);
process.stderr.write(declarationBuild.stderr);
if (declarationBuild.exitCode !== 0) process.exit(declarationBuild.exitCode);
await mkdir(output, { recursive: true });
const stage = await mkdtemp(join(tmpdir(), 'corvidae-agent-library-'));
try {
  for (const source of pending) {
    const [owner, ...sourcePath] = relative(join(repository, 'packages'), source).split('/');
    const declaration = join(repository, 'packages', owner ?? '', '.types', ...sourcePath).replace(
      /\.ts$/,
      '.d.ts',
    );
    const base = join(stage, releasePath(source));
    const runtime = ts.transpileModule(await Bun.file(source).text(), {
      fileName: source,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true,
      },
    }).outputText;
    await Bun.write(base + '.js', rewriteModules(runtime, source));
    await Bun.write(base + '.d.ts', rewriteModules(await Bun.file(declaration).text(), source));
  }
  if (externalDependencies.has('js-yaml')) externalDependencies.add('@types/js-yaml');
  const dependencyVersions = [...externalDependencies]
    .toSorted()
    .map((name) => [name, dependencyVersion(name)] as const);
  const optionalPeer = library === 'armorer' ? '@openai/agents' : '@anthropic-ai/sdk';
  const peerNames = new Set(['zod', '@opentelemetry/api', optionalPeer]);
  const dependencies = Object.fromEntries(
    dependencyVersions.filter(([name]) => !peerNames.has(name)),
  );
  const peerDependencies = Object.fromEntries(
    dependencyVersions.filter(([name]) => peerNames.has(name)),
  );
  const nodeOnly = new Set(['./export', './markdown', './adapters/anthropic/sdk']);
  const exports = Object.fromEntries(
    [...entries].map(([key, source]) => {
      const base = './' + releasePath(source);
      return [
        key,
        {
          types: base + '.d.ts',
          ...(library === 'conversationalist' && nodeOnly.has(key) ? { browser: null } : {}),
          default: base + '.js',
        },
      ];
    }),
  );
  await Bun.write(
    join(stage, 'package.json'),
    JSON.stringify(
      {
        name: packageName,
        version,
        description: workspaceManifest.description,
        type: 'module',
        license: 'MIT',
        sideEffects: false,
        repository: {
          type: 'git',
          url: 'git+https://github.com/stevekinney/corvidae.git',
          directory: 'packages/' + library,
        },
        engines: library === 'bungalow' ? { bun: '>=1.4.4' } : { node: '>=22', bun: '>=1.4.0' },
        ...(library === 'bungalow' ? { os: ['darwin', 'linux'] } : {}),
        exports,
        dependencies,
        peerDependencies,
        ...(Object.hasOwn(peerDependencies, optionalPeer)
          ? { peerDependenciesMeta: { [optionalPeer]: { optional: true } } }
          : {}),
      },
      undefined,
      2,
    ),
  );
  await copyFile(join(repository, 'LICENSE'), join(stage, 'LICENSE'));
  const readme = await Bun.file(join(workspace, 'README.md')).text();
  await Bun.write(
    join(stage, 'README.md'),
    readme
      .replace(
        /^## Workspace usage\n\n[^\n]+/m,
        '## Installation\n\n```sh\n' +
          (library === 'bungalow' ? 'bun add ' : 'npm install ') +
          packageName +
          '\n```',
      )
      .replaceAll('(#workspace-usage)', '(#installation)'),
  );
  const receipt = await $`npm pack --ignore-scripts --json --pack-destination ${output}`
    .cwd(stage)
    .text();
  process.stdout.write(receipt);
} finally {
  await rm(stage, { recursive: true, force: true });
}
