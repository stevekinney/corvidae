import { describe, expect, test } from 'bun:test';
import {
  defaultKeychainServices,
  parseEnvironmentFile,
  resolveCredential,
  run,
  type CredentialRunDependencies,
} from './credentials.ts';
import { UsageError, type Runner } from './process-runner.ts';

// A recognisable fake, so every assertion about "never printed" can search for it.
const SECRET = 'sk-test-0123456789-not-a-real-credential';

interface World {
  environment?: Record<string, string | undefined>;
  platform?: string;
  hasSecurity?: boolean;
  keychain?: Record<string, string>;
  files?: Record<string, string>;
  worktreeRoot?: string;
  mainCheckout?: string;
}

function world(settings: World = {}) {
  const calls: string[][] = [];
  const executed: { command: string[]; environment: Record<string, string> }[] = [];
  const runner: Runner = (command) => {
    calls.push(command);
    // security find-generic-password -s <service> -a <name> -w
    const value = settings.keychain?.[`${command[3]}/${command[5]}`];
    return value === undefined
      ? { code: 44, stdout: '', stderr: 'could not be found' }
      : { code: 0, stdout: `${value}\n`, stderr: '' };
  };
  const dependencies: Partial<CredentialRunDependencies> = {
    environment: settings.environment ?? {},
    runner,
    platform: settings.platform ?? 'darwin',
    hasSecurity: () => settings.hasSecurity ?? true,
    readFile: (path) => settings.files?.[path],
    worktreeRoot: () => settings.worktreeRoot,
    mainCheckout: () => settings.mainCheckout,
    execute: (command, environment) => {
      executed.push({ command, environment });
      return 7;
    },
  };
  return { dependencies, calls, executed };
}

describe('parseEnvironmentFile', () => {
  test('reads plain, exported and quoted values, and skips comments and junk', () => {
    const parsed = parseEnvironmentFile(
      [
        '# a comment',
        '',
        'PLAIN=one',
        'export EXPORTED=two',
        "SINGLE='three # not a comment'",
        'DOUBLE="four \\"quoted\\" \\\\ and \\n newline"',
        'TRAILING=five # a comment',
        '  SPACED = six  ',
        'EMPTY=',
        'not a line',
        '1BAD=x',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      PLAIN: 'one',
      EXPORTED: 'two',
      SINGLE: 'three # not a comment',
      DOUBLE: 'four "quoted" \\ and \n newline',
      TRAILING: 'five',
      SPACED: 'six',
      EMPTY: '',
    });
  });

  test('handles CRLF line endings and a hash inside an unquoted token', () => {
    expect(parseEnvironmentFile('A=b#c\r\nB=d\r\n')).toEqual({ A: 'b#c', B: 'd' });
  });
});

describe('resolveCredential order', () => {
  test('the environment wins over the Keychain and files', () => {
    const { dependencies, calls } = world({
      environment: { TYPESAFE_API_KEY: SECRET },
      keychain: { 'typesafe-api/TYPESAFE_API_KEY': 'other' },
      files: { '/w/.env': 'TYPESAFE_API_KEY=file' },
      worktreeRoot: '/w',
    });
    expect(resolveCredential('TYPESAFE_API_KEY', {}, dependencies)).toEqual({
      source: 'environment',
      value: SECRET,
    });
    expect(calls).toEqual([]);
  });

  test('an empty environment value falls through', () => {
    const { dependencies } = world({
      environment: { LINEAR_API_KEY: '' },
      keychain: { 'linear-api/LINEAR_API_KEY': SECRET },
    });
    expect(resolveCredential('LINEAR_API_KEY', {}, dependencies).source).toBe('keychain');
  });

  test('the Keychain is asked with the default service and the variable name as the account', () => {
    const { dependencies, calls } = world({ keychain: { 'linear-api/LINEAR_API_KEY': SECRET } });
    expect(resolveCredential('LINEAR_API_KEY', {}, dependencies)).toEqual({
      source: 'keychain',
      value: SECRET,
    });
    expect(calls).toEqual([
      ['security', 'find-generic-password', '-s', 'linear-api', '-a', 'LINEAR_API_KEY', '-w'],
    ]);
  });

  test('every documented default service is mapped', () => {
    expect(defaultKeychainServices).toEqual({
      TYPESAFE_API_KEY: 'typesafe-api',
      LINEAR_API_KEY: 'linear-api',
      ANTHROPIC_API_KEY: 'anthropic-api',
      TURBO_TOKEN: 'turborepo-remote-cache',
    });
  });

  test('--keychain-service overrides the default, and an unknown name has no Keychain lookup', () => {
    const custom = world({ keychain: { 'my-service/ANYTHING': SECRET } });
    expect(
      resolveCredential('ANYTHING', { keychainService: 'my-service' }, custom.dependencies).source,
    ).toBe('keychain');
    const unknown = world({ keychain: { 'x/ANYTHING': SECRET } });
    expect(resolveCredential('ANYTHING', {}, unknown.dependencies).source).toBe('unavailable');
    expect(unknown.calls).toEqual([]);
  });

  test('the Keychain is skipped off macOS and when `security` is missing', () => {
    const linux = world({
      platform: 'linux',
      keychain: { 'linear-api/LINEAR_API_KEY': SECRET },
    });
    expect(resolveCredential('LINEAR_API_KEY', {}, linux.dependencies).source).toBe('unavailable');
    expect(linux.calls).toEqual([]);
    const missing = world({
      hasSecurity: false,
      keychain: { 'linear-api/LINEAR_API_KEY': SECRET },
    });
    expect(resolveCredential('LINEAR_API_KEY', {}, missing.dependencies).source).toBe(
      'unavailable',
    );
    expect(missing.calls).toEqual([]);
  });

  test('a failing or empty Keychain read falls through to the .env files', () => {
    const { dependencies } = world({
      files: { '/w/.env': `LINEAR_API_KEY=${SECRET}` },
      worktreeRoot: '/w',
    });
    expect(resolveCredential('LINEAR_API_KEY', {}, dependencies)).toEqual({
      source: '.env:/w/.env',
      value: SECRET,
    });
  });

  test("the worktree's .env beats the main checkout's, which is the last resort", () => {
    const both = world({
      files: { '/w/.env': 'K=worktree', '/m/.env': 'K=main' },
      worktreeRoot: '/w',
      mainCheckout: '/m',
    });
    expect(resolveCredential('K', {}, both.dependencies)).toEqual({
      source: '.env:/w/.env',
      value: 'worktree',
    });
    const onlyMain = world({
      files: { '/m/.env': 'K=main' },
      worktreeRoot: '/w',
      mainCheckout: '/m',
    });
    expect(resolveCredential('K', {}, onlyMain.dependencies)).toEqual({
      source: '.env:/m/.env',
      value: 'main',
    });
    // A worktree that lacks the variable still reaches the main checkout.
    const partial = world({
      files: { '/w/.env': 'OTHER=1', '/m/.env': 'K=main' },
      worktreeRoot: '/w',
      mainCheckout: '/m',
    });
    expect(resolveCredential('K', {}, partial.dependencies).source).toBe('.env:/m/.env');
  });

  test('outside a Git repository, and with nothing set, the credential is unavailable', () => {
    expect(resolveCredential('K', {}, world().dependencies)).toEqual({
      source: 'unavailable',
      value: undefined,
    });
  });

  test('rejects a name that is not an environment variable name', () => {
    expect(() => resolveCredential('NOT A NAME', {}, world().dependencies)).toThrow(UsageError);
    expect(() => resolveCredential('', {}, world().dependencies)).toThrow(UsageError);
  });
});

describe('run resolve', () => {
  test('prints only the source, with exit 0 when found', () => {
    const { dependencies } = world({ environment: { TYPESAFE_API_KEY: SECRET } });
    const result = run(['resolve', 'TYPESAFE_API_KEY'], dependencies);
    expect(result).toEqual({ code: 0, output: 'environment' });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test('prints unavailable with exit 1 when not found, and --json names the source', () => {
    const { dependencies } = world();
    expect(run(['resolve', 'TYPESAFE_API_KEY'], dependencies)).toEqual({
      code: 1,
      output: 'unavailable',
    });
    const json = world({ keychain: { 'typesafe-api/TYPESAFE_API_KEY': SECRET } });
    const result = run(['resolve', 'TYPESAFE_API_KEY', '--json'], json.dependencies);
    expect(JSON.parse(result.output)).toEqual({
      name: 'TYPESAFE_API_KEY',
      source: 'keychain',
      found: true,
    });
    expect(result.output).not.toContain(SECRET);
  });

  test('a .env source names the file, not the value', () => {
    const { dependencies } = world({
      files: { '/m/.env': `K=${SECRET}` },
      mainCheckout: '/m',
    });
    const result = run(['resolve', 'K'], dependencies);
    expect(result.output).toBe('.env:/m/.env');
    expect(result.output).not.toContain(SECRET);
  });
});

describe('run exec', () => {
  test('sets the variable for the command and exits with its code', () => {
    const { dependencies, executed } = world({ environment: { LINEAR_API_KEY: SECRET } });
    const result = run(
      ['exec', 'LINEAR_API_KEY', '--', 'bun', 'scripts/chef/linear.ts', '--flag', 'read'],
      dependencies,
    );
    expect(result).toEqual({ code: 7, output: '' });
    expect(executed).toEqual([
      {
        command: ['bun', 'scripts/chef/linear.ts', '--flag', 'read'],
        environment: { LINEAR_API_KEY: SECRET },
      },
    ]);
  });

  test('exits 3 without running anything when the value is unavailable, and prints no value', () => {
    const { dependencies, executed } = world();
    const result = run(['exec', 'TYPESAFE_API_KEY', '--', 'echo', 'hi'], dependencies);
    expect(result.code).toBe(3);
    expect(result.output).toContain('TYPESAFE_API_KEY is unavailable');
    expect(executed).toEqual([]);
  });

  test('--keychain-service reaches the lookup', () => {
    const { dependencies, executed } = world({ keychain: { 'custom/THING': SECRET } });
    run(['exec', 'THING', '--keychain-service', 'custom', '--', 'true'], dependencies);
    expect(executed[0]?.environment).toEqual({ THING: SECRET });
  });

  test('a command containing its own -- is passed through intact', () => {
    const { dependencies, executed } = world({ environment: { K: SECRET } });
    run(['exec', 'K', '--', 'git', 'diff', '--', 'file'], dependencies);
    expect(executed[0]?.command).toEqual(['git', 'diff', '--', 'file']);
  });
});

describe('usage errors', () => {
  const { dependencies } = world();
  test('reject missing pieces', () => {
    expect(() => run([], dependencies)).toThrow(UsageError);
    expect(() => run(['bogus', 'K'], dependencies)).toThrow(UsageError);
    expect(() => run(['resolve'], dependencies)).toThrow(UsageError);
    expect(() => run(['resolve', 'A', 'B'], dependencies)).toThrow(UsageError);
    expect(() => run(['resolve', 'K', '--', 'x'], dependencies)).toThrow(UsageError);
    expect(() => run(['resolve', 'K', '--bogus'], dependencies)).toThrow(UsageError);
    expect(() => run(['exec', 'K'], dependencies)).toThrow(UsageError);
    expect(() => run(['exec', 'K', '--'], dependencies)).toThrow(UsageError);
    expect(() => run(['exec', '--', 'true'], dependencies)).toThrow(UsageError);
    expect(() => run(['exec', 'K', '--json', '--', 'true'], dependencies)).toThrow(UsageError);
  });
});
