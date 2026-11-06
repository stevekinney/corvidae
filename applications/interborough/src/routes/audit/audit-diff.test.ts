import { describe, expect, test } from 'bun:test';

import { instructionPatch } from './audit-diff.ts';

describe('the patch of a change to an agent’s instructions', () => {
  test('keeps the lines that did not change as context around the ones that did', () => {
    const before = [
      'You handle refund requests and order questions.',
      'Always answer within two sentences.',
      'Escalate refunds over $100 to a person.',
    ].join('\n');
    const after = [
      'You handle refund requests and order questions.',
      'Answer in as many sentences as the question needs, and',
      'link the order page whenever an order number appears.',
      'Escalate refunds over $100 to a person.',
    ].join('\n');
    expect(instructionPatch(before, after)).toBe(
      [
        '--- a/instructions.md',
        '+++ b/instructions.md',
        '@@ -1,3 +1,4 @@',
        ' You handle refund requests and order questions.',
        '-Always answer within two sentences.',
        '+Answer in as many sentences as the question needs, and',
        '+link the order page whenever an order number appears.',
        ' Escalate refunds over $100 to a person.',
        '',
      ].join('\n'),
    );
  });

  test('is nothing when the two read the same, and handles an empty side', () => {
    expect(instructionPatch('same\n', 'same')).toBeUndefined();
    expect(instructionPatch('', 'new\n')).toContain('+new');
    expect(instructionPatch('old', '')).toContain('-old');
  });

  test('numbers a hunk past an unchanged stretch from where it starts in each text', () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    const changed = lines.map((line, index) => (index === 9 ? 'line ten' : line));
    expect(instructionPatch(lines.join('\n'), changed.join('\n'))).toContain('@@ -7,6 +7,6 @@');
  });

  test('a pair too long to compare is every old line removed and every new line added', () => {
    const big = Array.from({ length: 2100 }, (_, index) => `a${index}`).join('\n');
    const other = Array.from({ length: 2100 }, (_, index) => `b${index}`).join('\n');
    const patch = instructionPatch(big, other) ?? '';
    expect(patch.split('\n').filter((line) => line.startsWith('-a'))).toHaveLength(2100);
    expect(patch.split('\n').filter((line) => line.startsWith('+b'))).toHaveLength(2100);
  });
});
