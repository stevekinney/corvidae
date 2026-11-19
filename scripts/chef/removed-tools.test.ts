// Tools deleted as dead (SDLC review item 12): nothing called them, so they stay deleted.

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, UsageError } from './gate-run.ts';

const here = import.meta.dir;

describe('removed chef tools', () => {
  test('gate-run.ts has no run subcommand', () => {
    expect(() => run(['run', '--worktree', here, '--log', 'unused'])).toThrow(UsageError);
    expect(readFileSync(join(here, 'gate-run.ts'), 'utf8')).not.toMatch(/\brunGate\b/);
    expect(existsSync(join(here, 'gate-child.test-support.ts'))).toBe(false);
  });

  test('outcome-budget.ts is gone and nothing in scripts/chef imports it', () => {
    expect(existsSync(join(here, 'outcome-budget.ts'))).toBe(false);
    const importers = readdirSync(here)
      .filter((name) => name.endsWith('.ts') && name !== 'removed-tools.test.ts')
      .filter((name) => readFileSync(join(here, name), 'utf8').includes('outcome-budget'));
    expect(importers).toEqual([]);
  });
});
