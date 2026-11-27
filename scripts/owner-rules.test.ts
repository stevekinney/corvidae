/**
 * The owner-rule register (`documentation/repository/owner-rules.json`) names a real guard for each
 * rule, and that guard runs in `lint:guards`.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { repositoryRoot } from './owner-rule-guard-support';

type RegisterRule = {
  id: string;
  rule: string;
  date: string;
  source: string;
  guard: { script: string; test: string; allowlist?: string } | null;
  scans?: string[];
  unguardedReason?: string;
};

/** The guard scripts `lint:guards` runs, as `scripts/check-x.ts` paths. */
export function chainedGuards(guards: string): string[] {
  return [
    ...guards.matchAll(/(?:^|&& )bun ((?:applications\/[\w-]+\/)?scripts\/[\w./-]+\.ts)/g),
  ].map((match) => match[1]!);
}

/** What is wrong with the register: a missing file, an unchained guard, a missing reason. */
export function judgeRegister(
  rules: readonly RegisterRule[],
  chained: readonly string[],
  exists: (path: string) => boolean,
): string[] {
  const problems: string[] = [];
  for (const rule of rules) {
    if (rule.guard === null) {
      if ((rule.unguardedReason?.length ?? 0) <= 40) {
        problems.push(`${rule.id} - no guard and no reason`);
      }
      continue;
    }
    if (rule.unguardedReason !== undefined) problems.push(`${rule.id} - a guard and a reason`);
    for (const path of [rule.guard.script, rule.guard.test, rule.guard.allowlist]) {
      if (path !== undefined && !exists(path)) problems.push(`${rule.id} - ${path} does not exist`);
    }
    if (!chained.includes(rule.guard.script)) {
      problems.push(`${rule.id} - ${rule.guard.script} is not chained in lint:guards`);
    }
  }
  return problems;
}

const register = (await Bun.file(
  join(repositoryRoot, 'documentation/repository/owner-rules.json'),
).json()) as { rules: RegisterRule[] };
const packageManifest = (await Bun.file(join(repositoryRoot, 'package.json')).json()) as {
  scripts: Record<string, string>;
};

const cleanRule: RegisterRule = {
  id: 'x',
  rule: 'A rule worded at some length.',
  date: '2026-11-19',
  source: 'A source of some length',
  guard: { script: 'scripts/a.ts', test: 'scripts/a.test.ts' },
};

describe('the owner-rule register', () => {
  test('every rule has an id, wording, an ISO date and a source, and ids are unique', () => {
    expect(register.rules.length).toBeGreaterThan(0);
    expect(new Set(register.rules.map((rule) => rule.id)).size).toBe(register.rules.length);
    for (const rule of register.rules) {
      expect(rule.rule.length).toBeGreaterThan(20);
      expect(rule.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(rule.source.length).toBeGreaterThan(10);
    }
  });

  test('every guard script, test and allowlist exists, and every guard is chained in lint:guards', () => {
    const problems = judgeRegister(
      register.rules,
      chainedGuards(packageManifest.scripts['lint:guards']!),
      (path) => existsSync(join(repositoryRoot, path)),
    );
    expect(problems).toEqual([]);
  });

  test('lint:guards joins every command with a spaced &&, so the chain parser sees each guard', () => {
    const guards = packageManifest.scripts['lint:guards']!;
    expect(guards).not.toMatch(/&&(?! )|(?<! )&&/);
    const commands = guards.split(' && ');
    for (const command of commands) {
      expect(command).toMatch(/^bun (?:applications\/[\w-]+\/)?scripts\/[\w./-]+\.ts$/);
    }
    expect(chainedGuards(guards)).toEqual(commands.map((command) => command.slice('bun '.length)));
  });

  test('fails on a guard script that does not exist', () => {
    const problems = judgeRegister(
      [cleanRule],
      ['scripts/a.ts'],
      (path) => path !== 'scripts/a.ts',
    );
    expect(problems).toEqual(['x - scripts/a.ts does not exist']);
  });

  test('fails on a test or an allowlist that does not exist', () => {
    const rule = { ...cleanRule, guard: { ...cleanRule.guard!, allowlist: 'scripts/a.json' } };
    const problems = judgeRegister([rule], ['scripts/a.ts'], (path) => path === 'scripts/a.ts');
    expect(problems).toEqual([
      'x - scripts/a.test.ts does not exist',
      'x - scripts/a.json does not exist',
    ]);
  });

  test('fails on a guard that is not chained in lint:guards', () => {
    expect(judgeRegister([cleanRule], ['scripts/b.ts'], () => true)).toEqual([
      'x - scripts/a.ts is not chained in lint:guards',
    ]);
  });

  test('fails on a rule with no guard and no reason', () => {
    expect(judgeRegister([{ ...cleanRule, guard: null }], [], () => true)).toEqual([
      'x - no guard and no reason',
    ]);
  });

  test('the scans a rule lists are the directories its guard reads', async () => {
    for (const rule of register.rules) {
      if (rule.guard === null) continue;
      const guard = (await import(join(repositoryRoot, rule.guard.script))) as {
        SCANNED_DIRECTORIES?: string[];
      };
      expect({ id: rule.id, scans: rule.scans }).toEqual({
        id: rule.id,
        scans: guard.SCANNED_DIRECTORIES,
      });
    }
  });

  test('chainedGuards reads each guard of a chain and nothing else', () => {
    expect(
      chainedGuards('bun scripts/check-a.ts && bun scripts/check-b.ts && echo bun scripts/c.ts'),
    ).toEqual(['scripts/check-a.ts', 'scripts/check-b.ts']);
  });
});
