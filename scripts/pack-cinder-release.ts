import { $, type BunPlugin } from 'bun';
import { copyFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import cinderManifest from '../components/cinder/package.json';
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

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-z-]+(?:\.[\da-z-]+)*)?$/i;
const { values } = parseArgs({
  options: {
    package: { type: 'string' },
    version: { type: 'string' },
    'markdown-version': { type: 'string' },
    'cinder-version': { type: 'string' },
    outdir: { type: 'string' },
  },
});
const name = values.package;
const version = values.version;
const markdownVersion = values['markdown-version'];
const cinderVersion = values['cinder-version'];
if (
  (name !== 'cinder' && name !== 'editor') ||
  !version ||
  !versionPattern.test(version) ||
  !markdownVersion ||
  !versionPattern.test(markdownVersion) ||
  (name === 'editor' && (!cinderVersion || !versionPattern.test(cinderVersion))) ||
  !values.outdir
) {
  throw new Error(
    'Usage: bun scripts/pack-cinder-release.ts --package <cinder|editor> --version <semver> --markdown-version <semver> [--cinder-version <semver>] --outdir <directory>',
  );
}
const isCinder = name === 'cinder';
const workspaceDirectory = `components/${name}`;
const workspaceRoot = join(repositoryRoot, workspaceDirectory);
const sourceManifest = isCinder ? cinderManifest : editorManifest;
const outputDirectory = resolve(values.outdir);
const catalog = new Map(Object.entries(repositoryManifest.catalog));
const publicDependencies = new Map([
  ['@lostgradient/markdown', markdownVersion],
  ['@lostgradient/cinder', cinderVersion],
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

const metadata = metadataSchema.parse(
  await Bun.file(join(workspaceRoot, '.metadata/components.json')).json(),
);
const entries = isCinder ? new Map(Object.entries(cinderEntries)) : editorEntries();
entries.set('./package.json', './package.json');
entries.set('./manifest', './.metadata/components.json');
await addComponentEntries(entries, workspaceRoot, metadata, isCinder);
const testOnly =
  /(?:^|\/)(?:__tests__|__fixtures__|[^/]+[-.]fixtures?(?:\.[^/]+)?|[^/]+\.(?:test|spec|test-support)\.[^/]+)$/;

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

  const ignoreServerStyles: BunPlugin = {
    name: 'ignore-server-styles',
    setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
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
    plugins: [ignoreServerStyles, sveltePlugin({ generate: 'server', development: false })],
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
      description: isCinder
        ? 'Cinder Svelte components and design tokens'
        : 'Cinder Markdown editors and review components',
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
