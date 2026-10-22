import { describe, expect, test } from 'bun:test';
import { parseOptions, requireOption, UsageError } from './process-runner.ts';

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
