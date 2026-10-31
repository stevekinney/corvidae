/**
 * Checks a folder plugin (COR-1883): `bun scripts/check-plugin.ts <plugin folder>`. The folder
 * holds `plugin.ts` (the plugin as its default export), usually with `content/` and a
 * `plugin.test.ts`, as `scripts/create-plugin.ts` writes it. Two checks run and both must pass:
 *
 * - the folder type-checks against the declarations of `@lostgradient/interborough-plugin`
 *   (`plugin.test.ts` and other test files are not type-checked: they import Bureau, which has no
 *   declarations of its own to check against);
 * - `pluginContract`'s checks pass with Bureau's `createPluginTestHost` as the host.
 *
 * A folder plugin lives outside the repository and has no `node_modules`, so the folder is copied
 * to a scratch directory beside a `node_modules` that links the workspaces a plugin may import
 * (`allowedPluginInternalDependency`, plus the authoring package, Bureau's testing export and
 * `zod`). The scratch directory is removed afterwards, and a diagnostic names the original path.
 * Exits 0 when the plugin conforms, 1 when it does not, 2 on a usage error.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { allowedPluginInternalDependency } from './plugin-dependency-rules.ts';

const repositoryRoot = resolve(import.meta.dir, '..');
const authoringPackage = join(repositoryRoot, 'packages/interborough-plugin');
const contractRunner = join(repositoryRoot, 'packages/bureau/scripts/run-plugin-contract.ts');

/** The workspace packages and external packages a folder plugin can import, by name. */
function importablePackages(): Map<string, string> {
  const links = new Map<string, string>();
  const packagesDirectory = join(repositoryRoot, 'packages');
  for (const entry of readdirSync(packagesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDirectory, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const { name } = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string };
    if (
      allowedPluginInternalDependency(name) ||
      name === '@lostgradient/bureau' ||
      name === '@lostgradient/interborough-plugin'
    ) {
      links.set(name, join(packagesDirectory, entry.name));
    }
  }
  links.set('zod', join(authoringPackage, 'node_modules/zod'));
  links.set('@types/bun', join(authoringPackage, 'node_modules/@types/bun'));
  return links;
}

async function linkPackages(scratch: string): Promise<void> {
  for (const [name, target] of importablePackages()) {
    const link = join(scratch, 'node_modules', name);
    await mkdir(join(link, '..'), { recursive: true });
    await symlink(target, link);
  }
}

async function run(
  command: string[],
  cwd: string,
): Promise<{ exitCode: number | null; output: string }> {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode: child.exitCode, output: `${out}${err}` };
}

/** The problems found in `folder`; empty when the plugin conforms. */
export async function checkPlugin(folder: string): Promise<string[]> {
  const source = resolve(folder);
  if (!existsSync(join(source, 'plugin.ts'))) return [`${source} has no plugin.ts.`];
  const scratch = await mkdtemp(join(tmpdir(), 'corvidae-check-plugin-'));
  try {
    const copy = join(scratch, 'plugin');
    await cp(source, copy, {
      recursive: true,
      filter: (path) => !path.split('/').includes('node_modules'),
    });
    await linkPackages(scratch);
    await writeFile(
      join(scratch, 'tsconfig.json'),
      JSON.stringify({
        extends: join(repositoryRoot, 'internal/typescript/library.json'),
        include: ['plugin'],
        exclude: ['plugin/**/*.test.ts', 'node_modules'],
        references: [{ path: join(authoringPackage, 'tsconfig.source.json') }],
      }),
    );
    const problems: string[] = [];
    // A diagnostic names the copy as the compiler saw it: absolute, resolved, or relative to the
    // scratch directory. Each reads as the folder the author gave.
    const scratchName = basename(scratch);
    const copyPath = new RegExp(`(?:\\.\\./)*(?:[^\\s(:]*/)?${scratchName}/plugin/`, 'g');
    const named = (text: string): string => text.replace(copyPath, `${source}/`).trim();
    const typecheck = await run(
      [
        process.execPath,
        join(repositoryRoot, 'node_modules/typescript/bin/tsc'),
        '-b',
        join(scratch, 'tsconfig.json'),
        '--pretty',
        'false',
      ],
      scratch,
    );
    if (typecheck.exitCode !== 0) {
      problems.push(`Type errors in ${source}:\n${named(typecheck.output)}`);
    }
    const contract = await run([process.execPath, '--no-install', contractRunner, copy], scratch);
    if (contract.exitCode !== 0) {
      problems.push(named(contract.output));
    }
    return problems;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const folder = process.argv[2];
  if (folder === undefined) {
    process.stderr.write('Usage: bun scripts/check-plugin.ts <plugin folder>\n');
    process.exitCode = 2;
  } else {
    const problems = await checkPlugin(folder);
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.exitCode = problems.length === 0 ? 0 : 1;
  }
}
