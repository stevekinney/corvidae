/**
 * The derived metadata of a component package (cinder, chat, editor or terminal).
 *
 * ```sh
 * bun scripts/generate-component-artifacts.ts                 # the `metadata` task: write .metadata/
 * bun scripts/generate-component-artifacts.ts --check         # in lint: check what is committed
 * bun scripts/generate-component-artifacts.ts --fix           # rewrite the committed generated regions
 * bun ../cinder/scripts/generate-component-artifacts.ts --package-root .   # another package
 * ```
 *
 * The default mode is each package's `metadata` Turborepo task. It writes only the ignored
 * `.metadata/` directory (see `lib/metadata-files.ts`): each component's schema and variables, a
 * copy of its authored examples, the package's `components.json`, and Cinder's A2UI catalog, as
 * plain JSON with no Prettier pass. It never writes a committed file, so its outputs cannot
 * invalidate its own cache.
 *
 * `--check` runs in each package's `lint`, which depends on `metadata`: every README's generated
 * regions match `.metadata/`, every component has its README and accessibility review, the
 * authored constraints and examples are valid, and, in cinder, the root registries are current
 * and Bureau's copy of the A2UI catalog matches byte for byte.
 *
 * `--fix` rewrites what `--check` compares: the README regions (and, in cinder, the root
 * registries). It generates in memory, so it needs no `metadata` run first.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { componentPackage, type ComponentPackage } from './lib/component-package.ts';

type CheckStage = { issues: string[] };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runStage(name: string, stage: () => Promise<string[]>): Promise<CheckStage> {
  try {
    return { issues: await stage() };
  } catch (error) {
    process.stderr.write(`components:check — ${name} stage failed: ${errorMessage(error)}\n`);
    return { issues: [`${name}: stage threw — see error above`] };
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** The `metadata` task: regenerate the package's `.metadata/` from scratch. */
async function runMetadataMode(pkg: ComponentPackage): Promise<void> {
  const { discoverComponentDirectories } = await import('./discover-component-directories.ts');
  const { generateSchemaForComponent } = await import('./generate-component-schema.ts');
  const { generateVariablesForComponent } = await import('./generate-component-variables.ts');
  const { componentMetadataPath, metadataRoot } = await import('./lib/metadata-files.ts');
  rmSync(metadataRoot(pkg.root), { recursive: true, force: true });
  const components = await discoverComponentDirectories(pkg.root);
  if (components.length === 0) throw new Error(`${pkg.name} has no component directories`);
  // Sequential on purpose: the schema generator shares one module-cached ts-morph Project, whose
  // accumulated state makes concurrent calls order intersection members differently.
  for (const { directory, name } of components) {
    const schema = generateSchemaForComponent({
      typesFilePath: join(directory, `${name}.types.ts`),
      componentName: name,
    });
    writeJson(componentMetadataPath(pkg.root, name, 'schema'), schema.schema);
    const variables = await generateVariablesForComponent({
      componentDirectory: directory,
      componentName: name,
    });
    writeJson(componentMetadataPath(pkg.root, name, 'variables'), variables.variables);
    const examples = join(directory, `${name}.examples.json`);
    if (existsSync(examples)) {
      const target = componentMetadataPath(pkg.root, name, 'examples');
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(examples, target);
    }
  }
  const { writeManifest } = await import('./generate-manifest.ts');
  await writeManifest(pkg.root);
  if (pkg.isCinder) {
    const { writeA2uiCatalogMetadata } = await import('./generate-a2ui-catalog.ts');
    await writeA2uiCatalogMetadata();
  }
  process.stdout.write(`metadata — ${pkg.name}: ${components.length} component(s)\n`);
}

/** The commands that make what `--check` compares current again. */
function fixCommand(pkg: ComponentPackage): string {
  const script = pkg.isCinder
    ? 'bun ../../internal/component-tooling/scripts/generate-component-artifacts.ts'
    : 'bun ../../internal/component-tooling/scripts/generate-component-artifacts.ts --package-root .';
  return `cd ${pkg.root.slice(pkg.root.indexOf('components/'))} && ${script} --fix`;
}

async function runCheckMode(pkg: ComponentPackage): Promise<void> {
  const stages: CheckStage[] = [];
  if (pkg.isCinder) {
    stages.push(
      await runStage('root registries', async () => {
        const { checkRootRegistries } = await import('./generate-root-registries.ts');
        const issues = await checkRootRegistries();
        return issues.map((issue) => `root registries: ${issue.file} (${issue.reason})`);
      }),
      await runStage('Bureau catalog copy', async () => {
        const { checkBureauCatalogCopy } = await import('./generate-a2ui-catalog.ts');
        const issues = await checkBureauCatalogCopy();
        return issues.map((issue) => `a2ui catalog: ${issue}`);
      }),
    );
  }
  stages.push(
    await runStage('artifacts', async () => {
      const { checkComponentArtifacts } = await import('./component-artifact-operations.ts');
      const issues = await checkComponentArtifacts(pkg.root);
      return issues.map((issue) => `${issue.component}/${issue.file} (${issue.reason})`);
    }),
    await runStage('constraints', async () => {
      const { checkComponentConstraints } = await import('./check-component-constraints.ts');
      const issues = await checkComponentConstraints(pkg.root);
      return issues.map((issue) => `constraints: ${issue.name}/${issue.file} (${issue.reason})`);
    }),
    await runStage('examples', async () => {
      const { checkCommittedExamples } = await import('./check-component-examples.ts');
      const issues = await checkCommittedExamples(pkg.root);
      return issues.map((issue) => `examples: ${issue}`);
    }),
  );
  const issues = stages.flatMap((stage) => stage.issues);
  if (issues.length === 0) {
    process.stdout.write(`components:check — ${pkg.name} OK\n`);
    return;
  }
  process.stderr.write(
    `components:check — ${pkg.name}: stale or invalid. \`${fixCommand(pkg)}\` rewrites README regions${pkg.isCinder ? ' and the root registries' : ''}:\n`,
  );
  for (const issue of issues) process.stderr.write(`  • ${issue}\n`);
  process.exitCode = 1;
}

async function runFixMode(pkg: ComponentPackage, targetName: string | undefined): Promise<void> {
  const { discoverComponentDirectories } = await import('./discover-component-directories.ts');
  const { generateArtifactsForComponent, writeReadme } =
    await import('./component-artifact-operations.ts');
  const components = await discoverComponentDirectories(pkg.root);
  const filtered = targetName
    ? components.filter((component) => component.name === targetName)
    : components;
  if (filtered.length === 0) {
    process.stderr.write(
      targetName ? `No component named "${targetName}"\n` : 'No component directories found\n',
    );
    process.exitCode = 1;
    return;
  }
  for (const component of filtered) {
    if (await writeReadme(await generateArtifactsForComponent(component))) {
      process.stdout.write(`rewrote ${component.name}/README.md\n`);
    }
  }
  if (pkg.isCinder) {
    const { writeRootRegistries } = await import('./generate-root-registries.ts');
    for (const file of await writeRootRegistries()) process.stdout.write(`generated ${file}\n`);
  }
}

/** The `--package-root <dir>` argument, resolved against the working directory. */
function packageRootArgument(args: string[]): string | undefined {
  const index = args.indexOf('--package-root');
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined) throw new Error('--package-root needs a directory');
  return resolve(value);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const pkg = componentPackage(packageRootArgument(args));
  if (args.includes('--check')) return runCheckMode(pkg);
  if (args.includes('--fix')) {
    const names = args.filter(
      (arg, index) => !arg.startsWith('-') && args[index - 1] !== '--package-root',
    );
    return runFixMode(pkg, names[0]);
  }
  return runMetadataMode(pkg);
}

if (import.meta.main) await main();
