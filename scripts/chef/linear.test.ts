import { describe, expect, test } from 'bun:test';

import { normalizeMarkdown, parseClaim, parseLease } from './linear.ts';

describe('Linear marker parsing', () => {
  test('normalizes Markdown without provider or host-lock work', () => {
    expect(normalizeMarkdown('* item')).toBe(normalizeMarkdown('- item'));
  });

  test('parses claim and lease first-line markers', () => {
    expect(
      parseClaim(
        'Claim: run run-a, branch branch-a, since 2026-10-22T12:00:00Z, checkpoint 2026-10-22T12:00:00Z, head none, status held',
      ),
    ).toMatchObject({ run: 'run-a' });
    expect(
      parseLease(
        'Lease: run run-a, since 2026-10-22T12:00:00Z, renewed 2026-10-22T12:00:00Z, status held',
      ),
    ).toMatchObject({ run: 'run-a' });
  });
});

describe('normalizeMarkdown', () => {
  test('normalizes rewritten links and code-span URLs', () => {
    expect(
      normalizeMarkdown(
        'on [npmjs.com](<http://npmjs.com>) and [https://a.example/x](<https://a.example/x>)',
      ),
    ).toBe(normalizeMarkdown('on npmjs.com and https://a.example/x'));
    expect(normalizeMarkdown('Canvas: [https://a.example/x](<https://a.example/x>).')).toBe(
      normalizeMarkdown('Canvas: `https://a.example/x`.'),
    );
  });

  test('retains differing link text', () => {
    expect(normalizeMarkdown('[docs](https://a.example)')).not.toBe(normalizeMarkdown('docs'));
  });

  test('normalizes tables and bullet styles', () => {
    expect(normalizeMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- one\n- two')).toBe(
      normalizeMarkdown('| a | b |\n| -- | -- |\n| 1 | 2 |\n\n* one\n* two  \n'),
    );
  });

  test('preserves horizontal rules', () => {
    expect(normalizeMarkdown('before\n\n---\n\nafter')).not.toBe(
      normalizeMarkdown('before\n\nafter'),
    );
  });

  test('leaves non-table pipes alone', () => {
    expect(normalizeMarkdown('const label = "A | B";')).not.toBe(
      normalizeMarkdown('const label = "A|B";'),
    );
  });

  test('detects changed table cells', () => {
    expect(normalizeMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')).not.toBe(
      normalizeMarkdown('| a | b |\n| -- | -- |\n| 1 | 3 |'),
    );
  });
});
