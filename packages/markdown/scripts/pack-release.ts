import { $ } from 'bun';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import repositoryManifest from '../../../package.json';
import publishedSurfaces from '../../../scripts/published-exports.json';
import sourceManifest from '../package.json';

const repositoryRoot = resolve(import.meta.dir, '../../..');
const workspaceDirectory = 'packages/markdown';
const workspaceRoot = join(repositoryRoot, workspaceDirectory);
const publishedSurface = publishedSurfaces.packages['@lostgradient/markdown'];
const workerSource = 'rendering/render-worker.ts';
const { values } = parseArgs({
  options: { outdir: { type: 'string' }, version: { type: 'string' } },
});

if (
  !values.outdir ||
  !values.version ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-z-]+(?:\.[\da-z-]+)*)?$/i.test(values.version)
) {
  throw new Error(
    'Usage: bun packages/markdown/scripts/pack-release.ts --version <semver without build metadata> --outdir <directory>',
  );
}
const outputDirectory = resolve(values.outdir);
const version = values.version;

type PublishedExport = string | { types: string; import: string; default: string };
const exports = Object.fromEntries<PublishedExport>(
  Object.entries(publishedSurface.exports).map(([specifier, entry]) => {
    if (typeof entry === 'string') return [specifier, entry];
    return [specifier, { types: entry.types, import: entry.import, default: entry.default }];
  }),
);
const dependencyVersions = new Map(Object.entries(repositoryManifest.catalog));
const dependencies = Object.fromEntries(
  Object.entries(sourceManifest.dependencies).map(([name, specifier]) => {
    const dependencyVersion = dependencyVersions.get(name);
    if (specifier !== 'catalog:' || !dependencyVersion) {
      throw new Error(`Expected a catalog version for Markdown dependency ${name}`);
    }
    return [name, dependencyVersion];
  }),
);

const scratch = await mkdtemp(join(tmpdir(), 'corvidae-markdown-release-'));
try {
  const staging = join(scratch, 'package');
  const distribution = join(staging, 'dist');
  const compilerConfiguration = join(scratch, 'tsconfig.json');
  const sourceEntries = Object.values(publishedSurface.exports)
    .filter((entry) => typeof entry !== 'string')
    .map((entry) => join(workspaceRoot, entry.bun));

  await Bun.write(
    compilerConfiguration,
    JSON.stringify({
      extends: join(repositoryRoot, 'internal/typescript/library.json'),
      compilerOptions: {
        noEmit: false,
        declaration: true,
        rootDir: join(workspaceRoot, 'src'),
        outDir: distribution,
        types: [],
        rewriteRelativeImportExtensions: true,
      },
      files: [...sourceEntries, join(workspaceRoot, 'src', workerSource)],
    }),
  );
  await $`${join(repositoryRoot, 'node_modules/.bin/tsc')} -p ${compilerConfiguration}`;

  const renderer = Bun.file(join(distribution, 'rendering/render-async.js'));
  const rendererSource = await renderer.text();
  const sourceWorkerUrl = "new URL('./render-worker.ts', import.meta.url)";
  if (rendererSource.split(sourceWorkerUrl).length !== 2) {
    throw new Error('Expected one source worker URL in the emitted Markdown renderer');
  }
  await Bun.write(
    renderer,
    rendererSource.replace(sourceWorkerUrl, "new URL('./render-worker.js', import.meta.url)"),
  );

  await Promise.all([
    copyFile(join(repositoryRoot, 'LICENSE'), join(staging, 'LICENSE')),
    copyFile(join(workspaceRoot, 'README.md'), join(staging, 'README.md')),
    Bun.write(
      join(staging, 'package.json'),
      JSON.stringify({
        name: sourceManifest.name,
        version,
        type: sourceManifest.type,
        license: repositoryManifest.license,
        repository: {
          type: 'git',
          url: 'git+https://github.com/stevekinney/corvidae.git',
          directory: workspaceDirectory,
        },
        files: ['dist'],
        exports,
        dependencies,
        sideEffects: ['**/render-worker.js'],
        publishConfig: { access: 'public' },
      }),
    ),
  ]);
  const exportedPaths = Object.values(exports).flatMap((entry) =>
    typeof entry === 'string' ? [entry] : Object.values(entry),
  );
  for (const path of [...new Set(exportedPaths), './dist/rendering/render-worker.js']) {
    if (!(await Bun.file(join(staging, path)).exists())) {
      throw new Error(`Missing Markdown release file ${path}`);
    }
  }

  await mkdir(outputDirectory, { recursive: true });
  await $`npm pack --ignore-scripts --json --pack-destination ${outputDirectory}`.cwd(staging);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
