import { describe, expect, test } from 'bun:test';
import {
  describeError,
  emitResult,
  parseOptions,
  requireOption,
  type ResultStreams,
  UsageError,
  wantsJson,
} from './process-runner.ts';

describe('parseOptions', () => {
  const specification = { values: ['config'], repeated: ['worktree'], flags: ['json'] };

  test('separates positionals, values, repeated values and flags', () => {
    const parsed = parseOptions(
      ['read', '--config', 'a.json', '--worktree', 'x', '--worktree', 'y', '--json', 'log'],
      specification,
    );
    expect(parsed.positionals).toEqual(['read', 'log']);
    expect(parsed.values).toEqual({ config: 'a.json' });
    expect(parsed.repeated).toEqual({ worktree: ['x', 'y'] });
    expect(parsed.flags.has('json')).toBe(true);
  });

  test('rejects an unknown option and a missing value', () => {
    expect(() => parseOptions(['--nope'], specification)).toThrow(UsageError);
    expect(() => parseOptions(['--config'], specification)).toThrow(UsageError);
  });

  test('requireOption names the missing option', () => {
    const parsed = parseOptions([], specification);
    expect(() => requireOption(parsed, 'config')).toThrow('--config is required.');
  });
});

describe('describeError', () => {
  test('keeps the name and a string code, and drops a message that quotes a value', () => {
    const SECRET = 'sk-test-0123456789-not-a-real-credential';
    const header = new TypeError(`Header 'Authorization' has invalid value: '${SECRET}'`);
    expect(describeError(header)).toBe('TypeError');
    const coded = Object.assign(new Error(`env ${SECRET}`), { code: 'ERR_INVALID_ARG_VALUE' });
    expect(describeError(coded)).toBe('Error ERR_INVALID_ARG_VALUE');
    for (const error of [header, coded]) expect(describeError(error)).not.toContain(SECRET);
  });

  test('ignores a code that is not an identifier and a thrown non-error', () => {
    expect(describeError(Object.assign(new Error('x'), { code: 'has a secret inside' }))).toBe(
      'Error',
    );
    expect(describeError(Object.assign(new Error('x'), { code: 7 }))).toBe('Error');
    expect(describeError('sk-a-string-with-a-secret')).toBe('unknown error');
  });
});

describe('emitResult', () => {
  function capture() {
    const written = { stdout: '', stderr: '' };
    const streams: ResultStreams = {
      stdout: { write: (text) => (written.stdout += text) },
      stderr: { write: (text) => (written.stderr += text) },
    };
    return { written, streams };
  }

  test('a success goes to stdout, with or without --json', () => {
    for (const argv of [['read'], ['read', '--json']]) {
      const { written, streams } = capture();
      emitResult(argv, { code: 0, output: 'ok' }, streams);
      expect(written).toEqual({ stdout: 'ok\n', stderr: '' });
    }
  });

  test('a failure goes to stderr as text and to stdout under --json', () => {
    const text = capture();
    emitResult(['read'], { code: 1, output: 'failed' }, text.streams);
    expect(text.written).toEqual({ stdout: '', stderr: 'failed\n' });
    const json = capture();
    emitResult(['read', '--json'], { code: 3, output: '{"ok":false}' }, json.streams);
    expect(json.written).toEqual({ stdout: '{"ok":false}\n', stderr: '' });
  });

  test('an empty output writes nothing', () => {
    const { written, streams } = capture();
    emitResult(['exec'], { code: 0, output: '' }, streams);
    emitResult(['exec', '--json'], { code: 7, output: '' }, streams);
    expect(written).toEqual({ stdout: '', stderr: '' });
  });

  test('wantsJson reads only the options before a wrapped command', () => {
    expect(wantsJson(['resolve', 'K', '--json'])).toBe(true);
    expect(wantsJson(['exec', 'K', '--', 'tool', '--json'])).toBe(false);
    expect(wantsJson([])).toBe(false);
  });
});
