import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { linkWorktree } from './link-turbo-config.ts';

function checkout(config?: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'turbo-link-'));
  if (config !== undefined) {
    mkdirSync(join(directory, '.turbo'));
    writeFileSync(join(directory, '.turbo', 'config.json'), config);
  }
  return directory;
}

describe('linkWorktree', () => {
  test('copies the main checkout link into a worktree that has none', () => {
    const main = checkout('{"teamId":"team_a"}');
    const worktree = checkout();
    expect(linkWorktree(main, worktree)).toBe(true);
    expect(readFileSync(join(worktree, '.turbo', 'config.json'), 'utf8')).toBe(
      '{"teamId":"team_a"}',
    );
  });

  test('never overwrites a link the worktree already has', () => {
    const main = checkout('{"teamId":"team_a"}');
    const worktree = checkout('{"teamId":"team_b"}');
    expect(linkWorktree(main, worktree)).toBe(false);
    expect(readFileSync(join(worktree, '.turbo', 'config.json'), 'utf8')).toBe(
      '{"teamId":"team_b"}',
    );
  });

  test('does nothing when the main checkout is not linked, or is the worktree', () => {
    const unlinked = checkout();
    expect(linkWorktree(unlinked, checkout())).toBe(false);
    const main = checkout('{"teamId":"team_a"}');
    expect(linkWorktree(main, main)).toBe(false);
  });
});
