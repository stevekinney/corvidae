/**
 * Generate or check the derived metadata of a component package: each component's schema,
 * variables and README regions, its constraints and examples, the package's `components.json`,
 * and, for cinder alone, the root metadata exports and the package-root registries
 * (`src/index.ts` component exports and `src/styles/components.css` imports, written by
 * `generate-root-registries.ts`).
 *
 * ```sh
 * bun scripts/generate-component-artifacts.ts [--check] [component]       # cinder
 * bun ../cinder/scripts/generate-component-artifacts.ts --package-root .  # chat, editor, terminal
 * ```
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Manifest } from './generate-manifest.ts';
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

async function runManifestCheck(
  pkg: ComponentPackage,
): Promise<{ stage: CheckStage; manifest?: Manifest }> {
  let manifest: Manifest | undefined;
  const stage = await runStage('manifest', async () => {
    const { buildManifest, manifestPathOf, renderManifest } =
      await import('./generate-manifest.ts');
    manifest = await buildManifest(pkg.root);
    const manifestPath = manifestPathOf(pkg);
    const generated = await renderManifest(pkg.root);
    const committed = existsSync(manifestPath) ? await Bun.file(manifestPath).text() : undefined;
    if (committed === generated) return [];
    process.stderr.write(
      `components:check — components.json is ${committed === undefined ? 'missing' : 'stale'}\n`,
    );
    return ['manifest: components.json is missing or stale'];
  });
  return manifest === undefined ? { stage } : { stage, manifest };
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
      for (const issue of issues) process.stderr.write(`components:check — examples: ${issue}\n`);
      return issues.map((issue) => `examples: ${issue}`);
    }),
  );
  const manifest = await runManifestCheck(pkg);
  stages.push(manifest.stage);
  if (pkg.isCinder) {
    stages.push(
      manifest.manifest === undefined
        ? { issues: ['root metadata exports: manifest unavailable'] }
        : await runStage('root metadata exports', async () => {
            const { checkRootMetadataExports } =
              await import('./generate-root-metadata-exports.ts');
            return checkRootMetadataExports(manifest.manifest as Manifest);
          }),
    );
  }
  const issues = stages.flatMap((stage) => stage.issues);
  if (issues.length === 0) {
    process.stdout.write(`components:check — ${pkg.name} OK\n`);
    return;
  }
  process.stderr.write(
    `components:check — ${pkg.name} drift detected. Run \`bun scripts/generate-component-artifacts.ts${pkg.isCinder ? '' : ' --package-root .'}\` in its package to fix:\n`,
  );
  for (const issue of issues) process.stderr.write(`  • ${issue}\n`);
  process.exitCode = 1;
}

async function runGenerateMode(
  pkg: ComponentPackage,
  targetName: string | undefined,
): Promise<void> {
  const { discoverComponentDirectories } = await import('./discover-component-directories.ts');
  const { generateArtifactsForComponent, writeArtifacts } =
    await import('./component-artifact-operations.ts');
  const components = await discoverComponentDirectories(pkg.root);
  const filtered = targetName
    ? components.filter((component) => component.name === targetName)
    : components;
  if (filtered.length === 0) {
    process.stderr.write(
      targetName
        ? `No component named "${targetName}"\n`
        : 'No directory-shaped components found\n',
    );
    process.exitCode = 1;
    return;
  }
  for (const component of filtered) {
    await writeArtifacts(await generateArtifactsForComponent(component));
    process.stdout.write(`generated ${component.name}\n`);
  }
  if (pkg.isCinder) {
    const { writeRootRegistries } = await import('./generate-root-registries.ts');
    for (const file of await writeRootRegistries()) process.stdout.write(`generated ${file}\n`);
  }
  if (targetName !== undefined) return;
  const { buildManifest, writeManifest } = await import('./generate-manifest.ts');
  await writeManifest(pkg.root);
  process.stdout.write('generated components.json\n');
  if (!pkg.isCinder) return;
  const { writeRootMetadataExports } = await import('./generate-root-metadata-exports.ts');
  await writeRootMetadataExports(await buildManifest());
  process.stdout.write('generated root metadata exports\n');
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
  const packageRoot = packageRootArgument(args);
  const pkg = componentPackage(packageRoot);
  if (args.includes('--check')) return runCheckMode(pkg);
  const rest = args.filter(
    (arg, index) => !arg.startsWith('-') && args[index - 1] !== '--package-root',
  );
  return runGenerateMode(pkg, rest[0]);
}

if (import.meta.main) await main();
