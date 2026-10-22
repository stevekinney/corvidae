import { describe, expect, test } from 'bun:test';
import { parseCommandLine, UsageError } from './worktree-scope.ts';

describe('parseCommandLine', () => {
  const bad: string[][] = [
    [],
    ['bogus'],
    ['capture'],
    ['capture', '--configuration', 'c'],
    ['verify', '--configuration', 'c'],
    ['verify', '--before', 'b'],
    // An unknown option is refused, not silently accepted.
    ['capture', '--configuration', 'c', '--output', 'o', '--bogus', 'x'],
    // A boolean-looking flag must not swallow the next argument and pass.
    ['capture', '--configuration', 'c', '--output', 'o', '--json'],
    ['verify', '--json', '--configuration', 'c', '--before', 'b'],
    ['capture', '--configuration', 'c', '--output', 'o', 'stray'],
    ['capture', '--configuration'],
    // An option that lost its value to the next option.
    ['capture', '--configuration', 'c', '--output', '--configuration', 'd'],
    // `--before` belongs to verify only.
    ['capture', '--configuration', 'c', '--output', 'o', '--before', 'b'],
  ];
  for (const argv of bad) {
    test(`rejects ${JSON.stringify(argv)} as a usage error`, () => {
      expect(() => parseCommandLine(argv)).toThrow(UsageError);
    });
  }

  test('accepts the documented forms', () => {
    const capture = parseCommandLine(['capture', '--configuration', 'c', '--output', 'o']);
    expect(capture.command).toBe('capture');
    expect(capture.options.values).toEqual({ configuration: 'c', output: 'o' });
    const verify = parseCommandLine(['verify', '--configuration', 'c', '--before', 'b']);
    expect(verify.command).toBe('verify');
    expect(verify.options.values).toEqual({ configuration: 'c', before: 'b' });
  });
});
