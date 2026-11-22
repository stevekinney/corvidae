import { describe, expect, test } from 'bun:test';

import { unfrozenCopiedStateReads } from './check-copied-state-assertions';

describe('copied-state assertions', () => {
  test('flags a read of the copied state in a spec that never freezes timers', () => {
    const source = [
      'await button.click();',
      "await expect(button).toHaveAttribute('data-cinder-copied');",
      "const copied = page.locator('.chat-message-copy[data-cinder-copied]');",
    ].join('\n');
    expect(unfrozenCopiedStateReads(source)).toEqual([2, 3]);
  });

  test('allows the read once the spec freezes page timers', () => {
    const source = [
      'await freezePageTimers(page);',
      'await button.click();',
      "await expect(button).toHaveAttribute('data-cinder-copied');",
    ].join('\n');
    expect(unfrozenCopiedStateReads(source)).toEqual([]);
  });

  test('ignores comment lines that name the attribute', () => {
    const source = [
      '// The copied-state transition (data-cinder-copied) is covered elsewhere.',
      ' * `data-cinder-copied` marks the copied state.',
    ].join('\n');
    expect(unfrozenCopiedStateReads(source)).toEqual([]);
  });
});
