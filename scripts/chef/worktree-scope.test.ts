import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCommandLine,
  resolveVerifyInputs,
  ScopeError,
  type ScopeEvidence,
  UsageError,
} from './worktree-scope.ts';

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
    ['capture', '--configuration', 'c', '--output', '--bogus'],
    // `--before` belongs to verify only.
    ['capture', '--configuration', 'c', '--output', 'o', '--before', 'b'],
    // `--capture` belongs to verify only, and replaces `--configuration` and `--before`.
    ['capture', '--capture', 'c'],
    ['capture', '--configuration', 'c', '--output', 'o', '--capture', 'c'],
    ['verify', '--capture', 'c', '--configuration', 'c'],
    ['verify', '--capture', 'c', '--before', 'b'],
    ['verify', '--capture'],
    ['verify', '--capture', '--configuration'],
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

describe('verify --capture', () => {
  test('parses as a verify with the capture file alone', () => {
    const verify = parseCommandLine(['verify', '--capture', 'evidence.json']);
    expect(verify.command).toBe('verify');
    expect(verify.options.values).toEqual({ capture: 'evidence.json' });
  });

  test('reads the root and allowed paths from the capture and uses it as the baseline', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'worktree-scope-capture-'));
    try {
      const evidence: ScopeEvidence = {
        version: 1,
        captureId: 'abc',
        capturedAt: '2026-10-27T00:00:00Z',
        head: 'deadbeef',
        root: '/work/tree',
        paths: ['docs', 'src'],
        entries: [],
      };
      const path = join(sandbox, 'capture.json');
      writeFileSync(path, JSON.stringify(evidence));
      const inputs = resolveVerifyInputs(parseCommandLine(['verify', '--capture', path]).options);
      expect(inputs.configuration).toEqual({ root: '/work/tree', paths: ['docs', 'src'] });
      expect(inputs.before).toEqual(evidence);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('an unreadable capture is a scope error, not a usage error', () => {
    expect(() =>
      resolveVerifyInputs(
        parseCommandLine(['verify', '--capture', '/nonexistent/capture.json']).options,
      ),
    ).toThrow(ScopeError);
  });
});
