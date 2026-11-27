import { $, type BunPlugin } from 'bun';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import ts from 'typescript';
import { z } from 'zod';
import chatManifest from '../components/chat/package.json';
import cinderManifest from '../components/cinder/package.json';
import { ensureCinderGenerated } from '../components/cinder/scripts/ensure-cinder-generated.ts';
import editorManifest from '../components/editor/package.json';
import repositoryManifest from '../package.json';
import { sveltePlugin } from '../testing/testing/src/svelte-plugin.ts';
import publishedSurfaces from './published-exports.json';

const repositoryRoot = resolve(import.meta.dir, '..');
const metadataSchema = z.object({
  components: z.array(
    z.object({
      id: z.string().regex(/^[a-z\d-]+$/),
      artifacts: z.object({
        schema: z.string(),
        variables: z.string(),
        examples: z.string().optional(),
        constraints: z.string().optional(),
        enhancement: z.string().optional(),
      }),
    }),
  ),
});

const cinderEntries = {
  '.': './src/index.ts',
  './panel': './src/panel/index.ts',
  './icons': './src/components/icons/index.ts',
  './styles': './src/styles/index.css',
  './styles/all': './src/styles/all.css',
  './styles/tokens': './src/styles/tokens.css',
  './styles/foundation': './src/styles/foundation.css',
  './styles/utilities': './src/styles/utilities.css',
  './styles/json-highlight': './src/styles/json-highlight.css',
  './styles/guard': './src/styles/base-guard.ts',
  './utilities.css': './src/styles/token-utilities.css',
  './tokens': './src/tokens/index.json',
  './tokens/runtime': './src/tokens/runtime/index.ts',
  './tokens/registry': './src/tokens/registry.generated.ts',
  './tokens/resolver': './src/tokens/cinder.resolver.json',
  './highlighters/shiki': './src/highlighters/shiki/default.ts',
  './highlighters/shiki/curated': './src/highlighters/shiki/index.ts',
  './tokens/sets/colors': './src/tokens/sets/colors.tokens.json',
  './tokens/sets/components': './src/tokens/sets/components.tokens.json',
  './tokens/sets/foundation': './src/tokens/sets/foundation.tokens.json',
  './tokens/sets/semantic': './src/tokens/sets/semantic.tokens.json',
  './tokens/themes/dark': './src/tokens/themes/dark.tokens.json',
  './tokens/themes/light': './src/tokens/themes/light.tokens.json',
  './tokens/modes/motion-default': './src/tokens/modes/motion-default.tokens.json',
  './tokens/modes/motion-reduced': './src/tokens/modes/motion-reduced.tokens.json',
  './tokens/modes/motion-forced-reduced': './src/tokens/modes/motion-forced-reduced.tokens.json',
  './tokens/resolved/dark': './src/tokens/resolved/dark.json',
  './tokens/resolved/light': './src/tokens/resolved/light.json',
  './tokens/resolved/dark-reduced-motion': './src/tokens/resolved/dark-reduced-motion.json',
  './tokens/resolved/light-reduced-motion': './src/tokens/resolved/light-reduced-motion.json',
};

type ExportTarget = string | { types: string; browser?: string; svelte?: string; default: string };

function editorEntries(): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(
    publishedSurfaces.packages['@lostgradient/editor'].exports,
  )) {
    if (typeof value === 'string') continue;
    result.set(
      key,
      'svelte' in value ? value.svelte : value.default.replace('./dist/', './src/lib/'),
    );
  }
  result.set('.', './src/index.ts');
  return result;
}

function addComponentEntries(
  entries: Map<string, string>,
  workspaceRoot: string,
  metadata: z.infer<typeof metadataSchema>,
  isCinder: boolean,
): Promise<void[]> {
  return Promise.all(
    metadata.components.map(async ({ id, artifacts }) => {
      const source = `./src/components/${id}`;
      if (isCinder) {
        entries.set(`./${id}`, `${source}/index.ts`);
        const stylesheet = `${source}/${id}.css`;
        if (await Bun.file(join(workspaceRoot, stylesheet)).exists()) {
          entries.set(`./${id}/styles`, stylesheet);
        }
      }
      for (const [kind, path] of Object.entries(artifacts)) {
        if (path !== undefined) entries.set(`./${id}/${kind}`, `./${path}`);
      }
    }),
  );
}

function chatEntries(metadata: z.infer<typeof metadataSchema>): Map<string, string> {
  const entries = new Map<string, string>([['.', './src/index.ts']]);
  for (const { id, artifacts } of metadata.components) {
    const source = `./src/lib/components/${id}`;
    const prefix = id === 'chat' ? '' : `./${id.replace(/^chat-/, '')}`;
    if (prefix) entries.set(prefix, `${source}/index.ts`);
    entries.set(`${prefix || '.'}/styles`, `${source}/${id}.css`);
    for (const [kind, path] of Object.entries(artifacts)) {
      if (path !== undefined) entries.set(`${prefix || '.'}/${kind}`, `./${path}`);
    }
  }
  return entries;
}

async function addChatMetadataModules(
  stage: string,
  exports: Map<string, ExportTarget>,
): Promise<void> {
  await copyFile(
    join(repositoryRoot, 'internal/component-tooling/src/schema-types.ts'),
    join(stage, '.metadata/schema-types.d.ts'),
  );
  for (const [entry, target] of exports) {
    if (typeof target !== 'string') continue;
    const kind = entry.split('/').at(-1);
    if (kind !== 'schema' && kind !== 'variables') continue;
    const base = target.replace(/\.json$/, '');
    const value: unknown = await Bun.file(join(stage, target)).json();
    await Bun.write(join(stage, base + '.js'), `export default ${JSON.stringify(value)};\n`);
    const declaration =
      kind === 'schema'
        ? "import type { ComponentSchema } from '../schema-types.js';\ndeclare const value: ComponentSchema;"
        : 'declare const value: readonly string[];';
    await Bun.write(join(stage, base + '.d.ts'), `${declaration}\nexport default value;\n`);
    exports.set(entry, { types: base + '.d.ts', default: base + '.js' });
  }
}

function normalizeDeclarations(source: string, path: string): string {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const edits: { start: number; end: number; text: string }[] = [];
  const rewrite = (node: ts.Node | undefined) => {
    if (!node || !ts.isStringLiteralLike(node) || !node.text.startsWith('.')) return;
    let target = node.text.replace(/\.svelte$/, '.svelte.js').replace(/(?<!\.d)\.ts$/, '.js');
    if (!extname(target)) {
      const candidate = resolve(dirname(path), target);
      if (existsSync(candidate + '.d.ts')) target += '.js';
      else if (existsSync(join(candidate, 'index.d.ts')))
        target = target.replace(/\/$/, '') + '/index.js';
    }
    if (target !== node.text) {
      edits.push({ start: node.getStart(file), end: node.getEnd(), text: JSON.stringify(target) });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      // Styles are loaded by the browser entry. They carry no declarations.
      if (
        !node.importClause &&
        ts.isStringLiteralLike(specifier) &&
        specifier.text.endsWith('.css')
      ) {
        edits.push({ start: node.getStart(file), end: node.getEnd(), text: '' });
        return;
      }
      rewrite(specifier);
    }
    if (ts.isExportDeclaration(node)) rewrite(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      rewrite(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return edits
    .toSorted((left, right) => right.start - left.start)
    .reduce(
      (current, { start, end, text }) => current.slice(0, start) + text + current.slice(end),
      source,
    );
}

async function stageSchemas(stage: string): Promise<void> {
  const schemas = join(repositoryRoot, 'internal/component-tooling/src/schemas');
  const destination = join(stage, '.metadata/schemas');
  const copied = new Set<string>();
  for (const member of new Bun.Glob('**/*.json').scanSync({ cwd: stage, dot: true })) {
    const path = join(stage, member);
    const file = Bun.file(path);
    const document: unknown = await file.json();
    if (!document || typeof document !== 'object' || !('$schema' in document)) continue;
    const schema = document.$schema;
    if (typeof schema !== 'string' || URL.canParse(schema)) continue;

    const shared =
      /(?:^|\/)internal\/component-tooling\/src\/schemas\/([A-Za-z\d_.-]+\.json)$/.exec(
        schema,
      )?.[1];
    let reference = schema;
    if (shared) {
      const target = join(destination, shared);
      if (!copied.has(shared)) {
        await mkdir(destination, { recursive: true });
        await copyFile(join(schemas, shared), target);
        copied.add(shared);
      }
      reference = relative(dirname(path), target).split(sep).join('/');
      document.$schema = reference;
      await Bun.write(file, `${JSON.stringify(document, null, 2)}\n`);
    }

    const resolved = resolve(dirname(path), reference);
    if (!resolved.startsWith(`${stage}${sep}`) || !(await Bun.file(resolved).exists())) {
      throw new Error(`${member} refers to an unavailable package schema: ${reference}`);
    }
  }
}

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-z-]+(?:\.[\da-z-]+)*)?$/i;
const { values } = parseArgs({
  options: {
    package: { type: 'string' },
    version: { type: 'string' },
    'markdown-version': { type: 'string' },
    'cinder-version': { type: 'string' },
    'conversationalist-version': { type: 'string' },
    outdir: { type: 'string' },
  },
});
const name = values.package;
const version = values.version;
const markdownVersion = values['markdown-version'];
const cinderVersion = values['cinder-version'];
const conversationalistVersion = values['conversationalist-version'];
if (
  (name !== 'cinder' && name !== 'editor' && name !== 'chat') ||
  !version ||
  !versionPattern.test(version) ||
  !markdownVersion ||
  !versionPattern.test(markdownVersion) ||
  (name !== 'cinder' && (!cinderVersion || !versionPattern.test(cinderVersion))) ||
  (name === 'chat' &&
    (!conversationalistVersion || !versionPattern.test(conversationalistVersion))) ||
  !values.outdir
) {
  throw new Error(
    'Usage: bun scripts/pack-cinder-release.ts --package <cinder|editor|chat> --version <semver> --markdown-version <semver> [--cinder-version <semver>] [--conversationalist-version <semver>] --outdir <directory>',
  );
}
const isCinder = name === 'cinder';
const workspaceDirectory = `components/${name}`;
const workspaceRoot = join(repositoryRoot, workspaceDirectory);
const manifests = { cinder: cinderManifest, editor: editorManifest, chat: chatManifest };
const sourceManifest = manifests[name];
const outputDirectory = resolve(values.outdir);
const catalog = new Map(Object.entries(repositoryManifest.catalog));
const publicDependencies = new Map([
  ['@lostgradient/markdown', markdownVersion],
  ['@lostgradient/cinder', cinderVersion],
  ['conversationalist', conversationalistVersion],
]);
const dependencies = new Map<string, string>();
for (const [dependency, specifier] of Object.entries(sourceManifest.dependencies)) {
  if (dependency === 'svelte') continue;
  const resolved =
    specifier === 'catalog:' ? catalog.get(dependency) : publicDependencies.get(dependency);
  if (!resolved) throw new Error(`No release version for ${dependency}`);
  dependencies.set(dependency, resolved);
}

const peerDependencies = new Map([['svelte', `^${repositoryManifest.catalog.svelte}`]]);
if (!isCinder) {
  for (const [dependency, dependencyVersion] of dependencies) {
    if (
      dependency.startsWith('@milkdown/') ||
      dependency.startsWith('prosemirror-') ||
      publicDependencies.has(dependency)
    ) {
      peerDependencies.set(dependency, dependencyVersion);
    }
  }
}

const cinderWorkspace = join(repositoryRoot, 'components/cinder');
await ensureCinderGenerated({ stdout: 2 });
await $`bun run types 1>&2`.cwd(cinderWorkspace);
if (!isCinder) {
  await $`bun run metadata 1>&2`.cwd(workspaceRoot);
  await $`bun run types 1>&2`.cwd(workspaceRoot);
}

const metadata = metadataSchema.parse(
  await Bun.file(join(workspaceRoot, '.metadata/components.json')).json(),
);
const entries =
  name === 'chat'
    ? chatEntries(metadata)
    : isCinder
      ? new Map(Object.entries(cinderEntries))
      : editorEntries();
entries.set('./package.json', './package.json');
entries.set('./manifest', './.metadata/components.json');
if (name !== 'chat') await addComponentEntries(entries, workspaceRoot, metadata, isCinder);
const testOnly =
  /(?:^|\/)(?:__tests__|__fixtures__|[^/]+[-.]fixtures?(?:\.[^/]+)?|[^/]+\.(?:test|spec|test-support)\.[^/]+)$/;
const tokenVersionFile = 'src/tokens/runtime/package-version.generated';
const tokenVersionLiteral = JSON.stringify(version);
const tokenVersionSource = `export const VERSION = ${tokenVersionLiteral};\n`;

const scratch = await mkdtemp(join(tmpdir(), `corvidae-${name}-release-`));
try {
  const stage = join(scratch, 'package');
  await mkdir(stage);
  for (const directory of ['src', '.types', '.metadata']) {
    await cp(join(workspaceRoot, directory), join(stage, directory), {
      recursive: true,
      filter: (path) => !testOnly.test(path),
    });
  }
  await stageSchemas(stage);
  if (isCinder) {
    await Bun.write(join(stage, `${tokenVersionFile}.ts`), tokenVersionSource);
    await Bun.write(
      join(stage, `.types/${tokenVersionFile}.d.ts`),
      `export declare const VERSION: ${tokenVersionLiteral};\n`,
    );
  }
  for (const path of new Bun.Glob('**/*.d.ts').scanSync({ cwd: stage, dot: true })) {
    if (!path.startsWith('.types/')) continue;
    const file = Bun.file(join(stage, path));
    const source = await file.text();
    const normalized = normalizeDeclarations(source, join(stage, path));
    if (normalized !== source) await Bun.write(file, normalized);
  }
  const exports = new Map<string, ExportTarget>();
  const modules = new Set<string>();
  for (const [entry, path] of entries) {
    if (!path.startsWith('./') || path.split('/').includes('..'))
      throw new Error(`Invalid export ${entry}: ${path}`);
    if (path.endsWith('.ts')) {
      if (!path.startsWith('./src/'))
        throw new Error(`Expected a source module for ${entry}: ${path}`);
      modules.add(join(workspaceRoot, path));
      exports.set(entry, {
        types: path.replace('./src/', './.types/src/').replace(/\.ts$/, '.d.ts'),
        browser: path,
        svelte: path,
        default: path.replace('./src/', './dist/').replace(/\.ts$/, '.js'),
      });
    } else if (path.endsWith('.css')) {
      exports.set(entry, { types: './dist/stylesheet.d.ts', default: path });
    } else {
      exports.set(entry, path);
    }
  }

  if (name === 'chat') await addChatMetadataModules(stage, exports);

  const serverSources: BunPlugin = {
    name: 'cinder-release-server-sources',
    setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
      if (isCinder) {
        const tokenVersionPath = join(workspaceRoot, `${tokenVersionFile}.ts`);
        builder.onLoad({ filter: /package-version\.generated\.ts$/ }, ({ path }) => {
          if (path === tokenVersionPath) return { contents: tokenVersionSource, loader: 'ts' };
          return undefined;
        });
      }
    },
  };
  const result = await Bun.build({
    entrypoints: [...modules].toSorted(),
    root: join(workspaceRoot, 'src'),
    outdir: join(stage, 'dist'),
    naming: { entry: '[dir]/[name].js', chunk: 'chunks/[name]-[hash].js' },
    splitting: true,
    target: 'node',
    format: 'esm',
    external: [...dependencies.keys(), 'svelte'].filter(
      (dependency) => dependency !== '@lucide/svelte',
    ),
    plugins: [serverSources, sveltePlugin({ generate: 'server', development: false })],
  });
  if (!result.success) throw new AggregateError(result.logs, `Failed to build ${name} for Node`);
  await Bun.write(join(stage, 'dist/stylesheet.d.ts'), 'export {};\n');
  await copyFile(join(repositoryRoot, 'LICENSE'), join(stage, 'LICENSE'));
  await copyFile(join(workspaceRoot, 'README.md'), join(stage, 'README.md'));
  await Bun.write(
    join(stage, 'package.json'),
    JSON.stringify({
      name: sourceManifest.name,
      version,
      description: {
        cinder: 'Cinder Svelte components and design tokens',
        editor: 'Cinder Markdown editors and review components',
        chat: 'Cinder Svelte components for chat and agent conversations',
      }[name],
      type: 'module',
      license: repositoryManifest.license,
      repository: {
        type: 'git',
        url: 'git+https://github.com/stevekinney/corvidae.git',
        directory: workspaceDirectory,
      },
      files: ['dist', 'src', '.types', '.metadata'],
      exports: Object.fromEntries(
        [...exports.entries()].toSorted(([left], [right]) => left.localeCompare(right)),
      ),
      dependencies: Object.fromEntries(dependencies),
      peerDependencies: Object.fromEntries(peerDependencies),
      sideEffects: sourceManifest.sideEffects,
      publishConfig: { access: 'public' },
    }),
  );
  for (const [entry, target] of exports) {
    for (const path of typeof target === 'string' ? [target] : Object.values(target)) {
      if (!(await Bun.file(join(stage, path)).exists()))
        throw new Error(`${entry} is missing ${path}`);
    }
  }
  await mkdir(outputDirectory, { recursive: true });
  await $`npm pack --ignore-scripts --json --pack-destination ${outputDirectory}`.cwd(stage);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
