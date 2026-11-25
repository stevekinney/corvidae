import { $ } from 'bun';
import { chmod, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import repositoryManifest from '../../../package.json';
import sourceManifest from '../package.json';

const repositoryRoot = resolve(import.meta.dir, '../../..');
const workspaceRoot = resolve(import.meta.dir, '..');
const { values } = parseArgs({
  options: {
    'cinder-version': { type: 'string' },
    outdir: { type: 'string' },
    version: { type: 'string' },
  },
});
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-z-]+(?:\.[\da-z-]+)*)?$/i;
const cinderVersion = values['cinder-version'];
const version = values.version;
if (
  !values.outdir ||
  !version ||
  !cinderVersion ||
  !versionPattern.test(version) ||
  !versionPattern.test(cinderVersion)
) {
  throw new Error(
    'Usage: bun packages/cinder-mcp/scripts/pack-release.ts --version <semver> --cinder-version <semver> --outdir <directory>',
  );
}
const outputDirectory = resolve(values.outdir);
const dependencyVersions = new Map(Object.entries(repositoryManifest.catalog));
const dependencies = Object.fromEntries(
  Object.entries(sourceManifest.dependencies).map(([name, specifier]) => {
    if (name === '@lostgradient/cinder' && specifier === 'workspace:*')
      return [name, cinderVersion];
    const dependencyVersion = dependencyVersions.get(name);
    if (specifier !== 'catalog:' || !dependencyVersion) {
      throw new Error(`Expected a catalog version for Cinder MCP dependency ${name}`);
    }
    return [name, dependencyVersion];
  }),
);

const scratch = await mkdtemp(join(tmpdir(), 'corvidae-cinder-mcp-release-'));
try {
  const staging = join(scratch, 'package');
  const distribution = join(staging, 'dist');
  const compilerConfiguration = join(scratch, 'tsconfig.json');
  await Bun.write(
    compilerConfiguration,
    JSON.stringify({
      extends: join(repositoryRoot, 'internal/typescript/library.json'),
      compilerOptions: {
        noEmit: false,
        declaration: true,
        rootDir: join(workspaceRoot, 'src'),
        outDir: distribution,
        typeRoots: [join(workspaceRoot, 'node_modules/@types')],
        rewriteRelativeImportExtensions: true,
      },
      files: ['index.ts', 'bin.ts'].map((entry) => join(workspaceRoot, 'src', entry)),
    }),
  );
  await $`${join(repositoryRoot, 'node_modules/.bin/tsc')} -p ${compilerConfiguration}`;

  const executable = join(distribution, 'bin.js');
  const executableSource = await Bun.file(executable).text();
  if (!executableSource.startsWith('#!/usr/bin/env node\n')) {
    throw new Error('Cinder MCP release executable is missing its Node shebang');
  }
  await chmod(executable, 0o755);
  await Promise.all([
    copyFile(join(repositoryRoot, 'LICENSE'), join(staging, 'LICENSE')),
    copyFile(join(workspaceRoot, 'README.md'), join(staging, 'README.md')),
    Bun.write(
      join(staging, 'package.json'),
      JSON.stringify({
        name: sourceManifest.name,
        version,
        description: sourceManifest.description,
        type: sourceManifest.type,
        license: repositoryManifest.license,
        repository: {
          type: 'git',
          url: 'git+https://github.com/stevekinney/corvidae.git',
          directory: 'packages/cinder-mcp',
        },
        files: ['dist'],
        exports: {
          '.': { types: './dist/index.d.ts', import: './dist/index.js' },
          './package.json': './package.json',
        },
        bin: { 'cinder-mcp': 'dist/bin.js' },
        engines: { node: '>=18' },
        dependencies,
        publishConfig: { access: 'public' },
      }),
    ),
  ]);

  await mkdir(outputDirectory, { recursive: true });
  await $`npm pack --ignore-scripts --json --pack-destination ${outputDirectory}`.cwd(staging);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
