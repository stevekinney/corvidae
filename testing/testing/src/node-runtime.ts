import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { runWithHangGuard } from './hang-guard.ts';

export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  test,
} from './node-runtime-shim.ts';

const NODE_IDENTITY = 'process.stdout.write(process.versions.bun ? "bun" : process.release.name)';

export interface NodeTestOptions {
  readonly bundle?: boolean;
  readonly env?: Record<string, string | undefined>;
  readonly shim?: boolean;
}

export interface NodeTestResult {
  readonly exitCode: number | null;
  readonly failCount: number;
  readonly passCount: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly version: string;
}

async function nodeVersion(binary: string): Promise<string> {
  const result = await runWithHangGuard([binary, '--version']);
  const version = result.stdout.toString().trim();
  const major = /^v(\d+)\./u.exec(version)?.[1];
  if (result.exitCode !== 0 || major === undefined) {
    throw new Error(
      `Native Node binary ${binary} did not report a Node version: ${version || result.stderr}`,
    );
  }
  if (Number(major) < 22) {
    throw new Error(`Native Node binary ${binary} is ${version}; Node 22 or later is required.`);
  }
  return version;
}

async function isNativeNode(binary: string): Promise<boolean> {
  const result = await runWithHangGuard([binary, '--eval', NODE_IDENTITY]);
  return result.exitCode === 0 && result.stdout.toString() === 'node';
}

/** Locate Node 22+ without accepting Bun's `node` shims. */
export async function resolveNativeNode(): Promise<string> {
  const pinned = process.env['CORVIDAE_NODE_BINARY'];
  if (pinned !== undefined && pinned !== '') {
    await nodeVersion(pinned);
    if (await isNativeNode(pinned)) return pinned;
    throw new Error(`CORVIDAE_NODE_BINARY does not name a native Node binary: ${pinned}`);
  }
  for (const directory of (process.env['PATH'] ?? '').split(delimiter).filter(existsSync)) {
    const candidate = Bun.which('node', { PATH: directory });
    if (candidate === null) continue;
    if (!(await isNativeNode(candidate))) continue;
    await nodeVersion(candidate);
    return candidate;
  }
  throw new Error('Native Node 22 or later is required on PATH.');
}

function count(tap: string, name: 'pass' | 'fail'): number {
  return Number(new RegExp(`^# ${name} (\\d+)$`, 'mu').exec(tap)?.[1] ?? 0);
}

function isWorkspacePackage(specifier: string): boolean {
  return (
    specifier.startsWith('@lostgradient/') ||
    specifier === 'armorer' ||
    specifier === 'conversationalist'
  );
}

async function bundledFiles(
  files: readonly string[],
): Promise<{ directory: string; files: string[] }> {
  // Keep the temporary entrypoints below the caller's checkout so Node can resolve the external
  // npm packages from its ancestor `node_modules` directory.
  const directory = mkdtempSync(join(process.cwd(), '.corvidae-node-runtime-'));
  const result = await Bun.build({
    entrypoints: [...files],
    format: 'esm',
    outdir: directory,
    target: 'node',
    naming: { entry: '[name]-[hash].mjs' },
    plugins: [
      {
        name: 'external-third-party-packages',
        setup(build) {
          build.onResolve({ filter: /.*/u }, (argument) => {
            if (
              argument.path.startsWith('.') ||
              argument.path.startsWith('/') ||
              isWorkspacePackage(argument.path)
            ) {
              return undefined;
            }
            if (argument.path.startsWith('node:')) return { path: argument.path, external: true };
            // Keep npm packages external, but preserve the workspace-local path Bun resolved so
            // Node does not try to find a package from the temporary bundle directory.
            return { path: Bun.resolveSync(argument.path, argument.importer), external: true };
          });
        },
      },
    ],
  });
  if (!result.success) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(result.logs.map((log) => log.message).join('\n'));
  }
  return { directory, files: result.outputs.map((output) => output.path) };
}

/** Run Node's TAP runner, optionally resolving `bun:test` and bundling extensionless workspace imports. */
export async function runNodeTests(
  files: readonly string[],
  options: NodeTestOptions = {},
): Promise<NodeTestResult> {
  const binary = await resolveNativeNode();
  const version = await nodeVersion(binary);
  const bundle = options.bundle === true ? await bundledFiles(files) : undefined;
  try {
    const command = [binary];
    if (options.shim === true)
      command.push('--import', new URL('./node-runtime-register.ts', import.meta.url).pathname);
    command.push('--test', '--test-reporter=tap', ...(bundle?.files ?? files));
    const child = await runWithHangGuard(
      command,
      options.env === undefined ? undefined : { env: options.env },
    );
    const stdout = child.stdout.toString();
    return {
      exitCode: child.exitCode,
      stdout,
      stderr: child.stderr.toString(),
      passCount: count(stdout, 'pass'),
      failCount: count(stdout, 'fail'),
      version,
    };
  } finally {
    if (bundle !== undefined) rmSync(bundle.directory, { recursive: true, force: true });
  }
}
