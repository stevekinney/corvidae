import { describe, expect, test } from 'bun:test';

import { normalizeMarkdown, parseClaim, parseLease } from './linear.ts';

describe('Linear marker parsing', () => {
  test('normalizes Markdown without provider or host-lock work', () => {
    expect(normalizeMarkdown('* item')).toBe(normalizeMarkdown('- item'));
  });

  test('parses claim and lease first-line markers', () => {
    expect(parseClaim('Claim: run run-a, branch branch-a, since 2026-10-22T12:00:00Z, checkpoint 2026-10-22T12:00:00Z, head none, status held')).toMatchObject({ run: 'run-a' });
    expect(parseLease('Lease: run run-a, since 2026-10-22T12:00:00Z, renewed 2026-10-22T12:00:00Z, status held')).toMatchObject({ run: 'run-a' });
  });
});
