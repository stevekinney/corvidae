import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pushVerifiedBundle, pushVerifiedCommit } from './authenticated-push.ts';
import { runCommand } from './packaging.ts';
import { git, gitEnvironment } from './sync.ts';

test.each(['push-url', 'included-rewrite', 'receive-pack'])(
  'authenticated push ignores target configuration: %s',
  async (attack) => {
    const root = await mkdtemp(join(tmpdir(), 'mirror-authenticated-push-'));
    try {
      const source = join(root, 'source');
      const remote = join(root, 'remote.git');
      await mkdir(source);
      await git(root, 'init', '--bare', remote);
      await git(source, 'init', '--initial-branch=main');
      await Bun.write(join(source, 'source.txt'), 'verified source');
      await git(source, 'add', '.');
      await git(source, 'commit', '-m', 'verified');
      const head = await git(source, 'rev-parse', 'HEAD');
      const commit = head.trim();
      await git(source, 'remote', 'add', 'origin', remote);
      const marker = join(root, 'helper-executed');
      const captured = join(root, 'captured-sentinel');
      const helper = join(root, 'untrusted-helper');
      await Bun.write(
        helper,
        `#!/bin/sh\nprintf invoked > '${marker}'\nprintf '%s' "$GIT_CONFIG_VALUE_0" "$GIT_CONFIG_VALUE_1" "$GIT_CONFIG_VALUE_2" > '${captured}'\nexit 1\n`,
      );
      await chmod(helper, 0o700);
      if (attack === 'push-url')
        await git(source, 'config', 'remote.origin.pushurl', `ext::${helper}`);
      if (attack === 'receive-pack')
        await git(source, 'config', 'remote.origin.receivepack', helper);
      if (attack === 'included-rewrite') {
        const included = join(root, 'included-config');
        await Bun.write(included, `[url "ext::${helper}"]\n insteadOf = ${remote}\n`);
        await git(source, 'config', 'include.path', included);
      }
      await git(source, 'config', 'credential.helper', `!${helper}`);
      const hooks = join(root, 'hooks');
      await mkdir(hooks);
      await Bun.write(join(hooks, 'pre-push'), await Bun.file(helper).text());
      await chmod(join(hooks, 'pre-push'), 0o700);
      await git(source, 'config', 'core.hooksPath', hooks);
      await git(source, 'config', 'protocol.ext.allow', 'always');
      let failure: unknown;
      const pushEnvironments: Record<string, string | undefined>[] = [];
      try {
        await pushVerifiedCommit({
          directory: source,
          remote,
          commit,
          branch: 'verified',
          environment: gitEnvironment({
            ...Bun.env,
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'include.path',
            GIT_CONFIG_VALUE_0: join(root, 'untrusted-config'),
          }),
          credentialEnvironment: async () =>
            gitEnvironment({
              ...Bun.env,
              GIT_CONFIG_VALUE_1: 'untrusted inherited configuration',
              GIT_CONFIG_COUNT: '1',
              GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
              GIT_CONFIG_VALUE_0: 'Authorization: Bearer harmless-test-sentinel',
            }),
          run: async (command, options) => {
            if (command.includes('push')) pushEnvironments.push(options?.env ?? {});
            return runCommand(command, options);
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(await Bun.file(marker).exists()).toBe(false);
      expect(await Bun.file(captured).exists()).toBe(false);
      expect(failure).toBeUndefined();
      expect(pushEnvironments).toHaveLength(1);
      expect(pushEnvironments[0]?.['GIT_CONFIG_VALUE_1']).toBe('');
      expect(pushEnvironments[0]?.['GIT_CONFIG_VALUE_2']).toBe(
        'Authorization: Bearer harmless-test-sentinel',
      );
      const pushedConfiguration = Array.from({ length: 3 }, (_, index) => [
        pushEnvironments[0]?.[`GIT_CONFIG_KEY_${index}`],
        pushEnvironments[0]?.[`GIT_CONFIG_VALUE_${index}`],
      ]);
      expect(pushedConfiguration).toEqual([
        ['core.hooksPath', '/dev/null'],
        ['credential.helper', ''],
        ['http.https://github.com/.extraHeader', 'Authorization: Bearer harmless-test-sentinel'],
      ]);
      const pushed = await git(remote, 'rev-parse', 'refs/heads/verified');
      expect(pushed.trim()).toBe(commit);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('refuses a different imported commit before requesting credentials', async () => {
  let requestedCredentials = false;
  const commands: string[][] = [];
  await expect(
    pushVerifiedCommit({
      directory: tmpdir(),
      remote: 'https://github.com/stevekinney/weft.git',
      commit: 'a'.repeat(40),
      branch: 'verified',
      environment: {},
      credentialEnvironment: async () => {
        requestedCredentials = true;
        return {};
      },
      run: async (command) => {
        commands.push([...command]);
        return {
          command: command.join(' '),
          exitCode: 0,
          stderr: '',
          stdout: command.includes('rev-parse') ? 'b'.repeat(40) : '',
        };
      },
    }),
  ).rejects.toThrow('Imported push commit does not match');
  expect(requestedCredentials).toBe(false);
  expect(commands.some((command) => command.includes('push'))).toBe(false);
});

test('refuses an invalid publish branch before requesting credentials', async () => {
  let requestedCredentials = false;
  const commands: string[][] = [];
  await expect(
    pushVerifiedBundle({
      bundle: join(tmpdir(), 'verified.bundle'),
      remote: 'https://github.com/stevekinney/weft.git',
      commit: 'a'.repeat(40),
      branch: 'refs/heads/main',
      environment: {},
      credentialEnvironment: async () => {
        requestedCredentials = true;
        return {};
      },
      run: async (command) => {
        commands.push([...command]);
        return {
          command: command.join(' '),
          exitCode: command.includes('check-ref-format') ? 1 : 0,
          stderr: 'invalid ref',
          stdout: '',
        };
      },
    }),
  ).rejects.toThrow('check-ref-format');
  expect(requestedCredentials).toBe(false);
  expect(commands.some((command) => command.includes('push'))).toBe(false);
});

test('pushVerifiedBundle requests credentials only after the bundle identity matches', async () => {
  let requestedCredentials = false;
  const commands: string[][] = [];
  await expect(
    pushVerifiedBundle({
      bundle: join(tmpdir(), 'verified.bundle'),
      remote: 'https://github.com/stevekinney/weft.git',
      commit: 'a'.repeat(40),
      branch: 'verified',
      environment: {},
      credentialEnvironment: async () => {
        requestedCredentials = true;
        return {};
      },
      run: async (command) => {
        commands.push([...command]);
        return {
          command: command.join(' '),
          exitCode: 0,
          stderr: '',
          stdout: command.includes('rev-parse') ? 'b'.repeat(40) : '',
        };
      },
    }),
  ).rejects.toThrow('Imported push commit does not match');
  expect(requestedCredentials).toBe(false);
  expect(commands.some((command) => command.includes('push'))).toBe(false);
});
