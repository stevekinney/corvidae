import { describe, expect, test } from 'bun:test';
import {
  createExecute,
  defaultKeychainServices,
  isUsableValue,
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

describe('a comment after an empty or unquoted value', () => {
  test('starts at a hash at the start of the value or after whitespace, never inside a token', () => {
    expect(parseEnvironmentFile('A= # just a comment\nB=# also a comment\nC=   #x')).toEqual({
      A: '',
      B: '',
      C: '',
    });
    expect(parseEnvironmentFile('D=value # trailing\nE=a#b\nF=a\t# tab comment')).toEqual({
      D: 'value',
      E: 'a#b',
      F: 'a',
    });
    // A quoted value keeps its hash, and what follows the closing quote is still ignored.
    expect(parseEnvironmentFile('G="# kept" # dropped')).toEqual({ G: '# kept' });
  });

  test('an empty value is unavailable instead of resolving to the comment text', () => {
    const { dependencies } = world({ files: { '/w/.env': 'K= # comment' }, worktreeRoot: '/w' });
    expect(resolveCredential('K', {}, dependencies).source).toBe('unavailable');
  });
});

describe('values that are not printable ASCII', () => {
  test('isUsableValue accepts printable ASCII only', () => {
    expect(isUsableValue(SECRET)).toBe(true);
    for (const bad of [
      '',
      'a b',
      ' a',
      'a\n',
      'a\tb',
      'a\u0000b',
      'caf\u00e9',
      '\u201csecret\u201d',
    ]) {
      expect(isUsableValue(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  const badValues: Record<string, string> = {
    'an embedded newline': `${SECRET}\n${SECRET}`,
    'curly quotes': `\u201c${SECRET}\u201d`,
    'an inner space': `${SECRET} ${SECRET}`,
    'a NUL character': `${SECRET}\u0000`,
  };

  for (const [label, value] of Object.entries(badValues)) {
    test(`an environment value with ${label} is ignored, and only its source is named`, () => {
      const { dependencies } = world({ environment: { LINEAR_API_KEY: value } });
      const resolution = resolveCredential('LINEAR_API_KEY', {}, dependencies);
      expect(resolution).toEqual({
        source: 'unavailable',
        value: undefined,
        rejected: ['environment'],
      });
      const resolve = run(['resolve', 'LINEAR_API_KEY'], dependencies);
      expect(resolve.code).toBe(1);
      expect(resolve.output).toContain(
        'unavailable (the value in environment is not printable ASCII',
      );
      const json = run(['resolve', 'LINEAR_API_KEY', '--json'], dependencies);
      expect(JSON.parse(json.output)).toEqual({
        name: 'LINEAR_API_KEY',
        source: 'unavailable',
        found: false,
        rejected: ['environment'],
      });
      const exec = run(['exec', 'LINEAR_API_KEY', '--', 'true'], dependencies);
      expect(exec.code).toBe(3);
      expect(exec.output).toContain('the value in environment is not printable ASCII');
      for (const text of [resolve.output, json.output, exec.output]) {
        expect(text).not.toContain(SECRET);
      }
    });
  }

  test('a .env value with an escaped newline or curly quotes is rejected without echoing it', () => {
    const { dependencies } = world({
      files: {
        '/w/.env': [`ESCAPED="${SECRET}\\n${SECRET}"`, `CURLY=\u201c${SECRET}\u201d`].join('\n'),
      },
      worktreeRoot: '/w',
    });
    for (const name of ['ESCAPED', 'CURLY']) {
      const resolution = run(['resolve', name], dependencies);
      expect(resolution.code).toBe(1);
      expect(resolution.output).toBe(
        'unavailable (the value in .env:/w/.env is not printable ASCII without whitespace, so it was ignored)',
      );
      expect(resolution.output).not.toContain(SECRET);
    }
  });

  test('a rejected source falls through to the next one, which supplies a usable value', () => {
    const { dependencies } = world({
      environment: { LINEAR_API_KEY: `${SECRET}\n` },
      keychain: { 'linear-api/LINEAR_API_KEY': 'from-keychain-0123456789' },
    });
    expect(resolveCredential('LINEAR_API_KEY', {}, dependencies)).toEqual({
      source: 'keychain',
      value: 'from-keychain-0123456789',
      rejected: ['environment'],
    });
    const result = run(['resolve', 'LINEAR_API_KEY'], dependencies);
    expect(result).toEqual({ code: 0, output: 'keychain' });
  });

  test('exec never starts the command with a value that is not usable', () => {
    const { dependencies, executed } = world({ environment: { K: 'two words' } });
    expect(run(['exec', 'K', '--', 'true'], dependencies).code).toBe(3);
    expect(executed).toEqual([]);
  });
});

describe('createExecute', () => {
  test('reports a spawn failure by name and code, never by a message that quotes the value', () => {
    const messages: string[] = [];
    const execute = createExecute(
      () => {
        throw Object.assign(new Error(`env value '${SECRET}' contains a NUL byte`), {
          code: 'ERR_INVALID_ARG_VALUE',
        });
      },
      (text) => messages.push(text),
    );
    expect(execute(['tool', '--flag'], { K: SECRET })).toBe(127);
    expect(messages).toEqual(['could not run tool (Error ERR_INVALID_ARG_VALUE)\n']);
    expect(messages.join('')).not.toContain(SECRET);
  });

  test('passes the added environment and inherits the streams, returning the exit code', () => {
    const seen: unknown[] = [];
    const execute = createExecute(
      (command, options) => {
        seen.push({ command, options });
        return { exitCode: 5 };
      },
      () => undefined,
    );
    expect(execute(['tool'], { K: 'v' })).toBe(5);
    expect(seen[0]).toMatchObject({
      command: ['tool'],
      options: { env: { K: 'v' }, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
    });
    expect(
      createExecute(
        () => ({ exitCode: null }),
        () => undefined,
      )(['tool'], {}),
    ).toBe(1);
  });
});
