import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { runCommand, type CommandRunner } from './packaging.ts';

export interface AuthenticatedPushOptions {
  directory: string;
  remote: string;
  commit: string;
  branch: string;
  environment: Record<string, string | undefined>;
  credentialEnvironment: () => Promise<Record<string, string | undefined>>;
  run?: CommandRunner;
}

function isolatedEnvironment(
  base: Record<string, string | undefined>,
  protocol: 'https' | 'file',
  credential?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const environment = Object.fromEntries(
    Object.entries(base).filter(([name]) => !name.startsWith('GIT_')),
  );
  const entries = [
    ['core.hooksPath', '/dev/null'],
    ['credential.helper', ''],
  ];
  if (credential) {
    const count = Number(credential['GIT_CONFIG_COUNT'] ?? 0);
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error('Invalid credential configuration');
    for (let index = 0; index < count; index++) {
      const key = credential[`GIT_CONFIG_KEY_${index}`];
      const value = credential[`GIT_CONFIG_VALUE_${index}`];
      if (key === 'http.https://github.com/.extraHeader' && typeof value === 'string')
        entries.push([key, value]);
    }
  }
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_COUNT: String(entries.length),
    ...Object.fromEntries(
      entries.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
    GIT_ALLOW_PROTOCOL: protocol,
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** Push only imported commit data; target-owned configuration never sees the credential. */
export async function pushVerifiedCommit(options: AuthenticatedPushOptions): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(options.commit)) throw new Error('Push requires an exact commit SHA');
  const protocol = isAbsolute(options.remote)
    ? 'file'
    : new URL(options.remote).protocol.slice(0, -1);
  if (protocol !== 'file' && protocol !== 'https')
    throw new Error('Push requires HTTPS or an absolute local repository path');
  const run = options.run ?? runCommand;
  const root = await mkdtemp(join(tmpdir(), 'mirror-push-'));
  const directory = join(root, 'repository.git');
  const bundle = join(root, 'commit.bundle');
  const environment = isolatedEnvironment(options.environment, 'file');
  const command = async (
    cwd: string,
    env: Record<string, string | undefined>,
    arguments_: readonly string[],
  ) => {
    const result = await run(['git', ...arguments_], { cwd, env });
    if (result.exitCode !== 0)
      throw new Error(
        `Isolated push Git command failed: ${arguments_[0]} (exit ${result.exitCode})`,
      );
    return result.stdout.trim();
  };
  try {
    // No credential is requested until the bundle has been imported and its identity checked.
    await command(options.directory, environment, ['bundle', 'create', bundle, 'HEAD']);
    await command(root, environment, ['init', '--bare', '--template=', directory]);
    await command(directory, environment, [
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      '--no-auto-gc',
      bundle,
      'HEAD:refs/heads/verified',
    ]);
    const imported = await command(directory, environment, ['rev-parse', 'refs/heads/verified']);
    if (imported !== options.commit)
      throw new Error('Imported push commit does not match the verified commit');
    const authenticated = isolatedEnvironment(
      options.environment,
      protocol,
      await options.credentialEnvironment(),
    );
    await command(directory, authenticated, [
      'push',
      options.remote,
      `${options.commit}:refs/heads/${options.branch}`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
