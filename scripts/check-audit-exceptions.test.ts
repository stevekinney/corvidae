import { describe, expect, test } from 'bun:test';
import type { AuditException } from './audit-exceptions';
import { auditExceptions } from './audit-exceptions';
import {
  buildGraph,
  checkExceptions,
  findExpiredExceptions,
  findUnauthorizedPaths,
  parseAdvisories,
  runAuditGate,
  validateRegistry,
  type CommandResult,
} from './check-audit-exceptions';

const ADVISORY = 'GHSA-vfj7-8cjw-p6xm';
const entry: AuditException = {
  advisory: ADVISORY,
  package: 'braces',
  allowedChains: [['ui', 'stylelint']],
  reason: 'No patched release.',
  trackingIssue: 'COR-1423',
  reviewBy: '2026-10-31',
};
const beforeReview = new Date('2026-10-03T12:00:00Z');

/** A lockfile where `braces` is reached only through `ui` (dev) > `stylelint` > `micromatch`. */
function lockfile(
  overrides: { rootDependencies?: object; uiDependencies?: object; uiDevelopment?: object } = {},
) {
  return `{
    // bun.lock is JSONC, so comments and trailing commas must parse.
    "lockfileVersion": 1,
    "workspaces": {
      "": { "name": "root", "devDependencies": ${JSON.stringify({ app: 'workspace:*', ...overrides.rootDependencies })}, },
      "components/ui": { "name": "ui", "devDependencies": ${JSON.stringify(overrides.uiDevelopment ?? { stylelint: '^1' })}, "dependencies": ${JSON.stringify(overrides.uiDependencies ?? {})}, },
      "applications/app": { "name": "app", "dependencies": { "ui": "workspace:*" }, },
    },
    "packages": {
      "app": ["app@workspace:applications/app"],
      "ui": ["ui@workspace:components/ui"],
      "stylelint": ["stylelint@1.0.0", "", { "dependencies": { "micromatch": "^4" } }, "sha"],
      "micromatch": ["micromatch@4.0.8", "", { "dependencies": { "braces": "^3" } }, "sha"],
      "braces": ["braces@3.0.3", "", {}, "sha"],
      "other": ["other@1.0.0", "", { "dependencies": { "micromatch": "^4" } }, "sha"],
    },
  }`;
}

const reporting = JSON.stringify({
  braces: [{ url: `https://github.com/advisories/${ADVISORY}`, severity: 'high' }],
  dompurify: [{ url: 'https://github.com/advisories/GHSA-p98j-92pf-mc4p', severity: 'low' }],
});

describe('registry validation', () => {
  test('accepts the shipped registry', () => {
    expect(validateRegistry(auditExceptions)).toEqual([]);
  });

  test.each([
    ['an advisory id that is not a GHSA', { advisory: 'CVE-2024-1234' }, 'is not a GHSA'],
    ['a lower-case-malformed GHSA', { advisory: 'GHSA-VFJ7-8CJW-P6XM' }, 'is not a GHSA'],
    ['a missing package', { package: '' }, 'missing "package"'],
    ['a missing reason', { reason: ' ' }, 'missing "reason"'],
    ['a missing tracking issue', { trackingIssue: '' }, 'missing "trackingIssue"'],
    ['a malformed tracking issue', { trackingIssue: 'tracking' }, 'not a tracking issue id'],
    ['a missing review-by date', { reviewBy: '' }, 'missing "reviewBy"'],
    ['an impossible review-by date', { reviewBy: '2026-02-31' }, 'not a valid YYYY-MM-DD'],
    ['no allowed chains', { allowedChains: [] }, '"allowedChains" must be'],
    ['a one-package chain', { allowedChains: [['ui']] }, '"allowedChains" must be'],
  ] as const)('rejects %s', (_label, override, message) => {
    expect(validateRegistry([{ ...entry, ...override }]).join('\n')).toContain(message);
  });

  test('rejects a duplicate advisory', () => {
    expect(validateRegistry([entry, entry]).join('\n')).toContain('duplicate advisory id');
  });
});

describe('review-by date', () => {
  test('is valid through the whole review-by day and expires the next day', () => {
    expect(findExpiredExceptions([entry], new Date('2026-10-31T23:59:59Z'))).toEqual([]);
    const expired = findExpiredExceptions([entry], new Date('2026-11-01T00:00:00Z'));
    expect(expired).toHaveLength(1);
    expect(expired[0]).toContain('COR-1423');
  });
});

describe('advisory report parsing', () => {
  test('reads advisory ids by package and rejects unreadable output', () => {
    expect(parseAdvisories(reporting)?.map(({ package: name, id }) => [name, id])).toEqual([
      ['braces', ADVISORY],
      ['dompurify', 'GHSA-p98j-92pf-mc4p'],
    ]);
    expect(parseAdvisories('{"braces": "nope"}')).toBeNull();
    expect(parseAdvisories('Error: network unreachable')).toBeNull();
  });
});

describe('reachability from the lockfile', () => {
  test('passes when the package is reached only through the allowed chain', () => {
    expect(findUnauthorizedPaths(buildGraph(lockfile()), 'braces', entry.allowedChains)).toEqual(
      [],
    );
  });

  test('fails when another package also reaches it', () => {
    const paths = findUnauthorizedPaths(
      buildGraph(lockfile({ rootDependencies: { other: '^1' } })),
      'braces',
      entry.allowedChains,
    );
    expect(paths).toEqual(['root > other > micromatch > braces']);
  });

  test('fails when the allowed importer reaches it as a runtime dependency', () => {
    const graph = buildGraph(lockfile({ uiDevelopment: {}, uiDependencies: { stylelint: '^1' } }));
    const paths = findUnauthorizedPaths(graph, 'braces', entry.allowedChains) ?? [];
    expect(paths).toContain('app > ui > stylelint > micromatch > braces');
    expect(paths).toContain('ui > stylelint > micromatch > braces');
  });

  test('resolves a nested lockfile entry before the hoisted one', () => {
    const nested = lockfile({ rootDependencies: { other: '^1' } }).replace(
      '"micromatch": ["micromatch@4.0.8", "", { "dependencies": { "braces": "^3" } }, "sha"]',
      '"micromatch": ["micromatch@4.0.8", "", {}, "sha"], "other/micromatch": ["micromatch@4.0.8", "", { "dependencies": { "braces": "^3" } }, "sha"]',
    );
    const paths = findUnauthorizedPaths(buildGraph(nested), 'braces', entry.allowedChains);
    expect(paths).toEqual(['root > other > micromatch > braces']);
  });

  test('ignores peer dependencies and reports an absent package as null', () => {
    const peerOnly = lockfile().replace(
      '"other": ["other@1.0.0", "", { "dependencies": { "micromatch": "^4" } }, "sha"]',
      '"other": ["other@1.0.0", "", { "peerDependencies": { "micromatch": "^4" } }, "sha"]',
    );
    const graph = buildGraph(
      peerOnly.replace('"app": "workspace:*"', '"app": "workspace:*", "other": "^1"'),
    );
    expect(findUnauthorizedPaths(graph, 'braces', entry.allowedChains)).toEqual([]);
    expect(findUnauthorizedPaths(graph, 'absent', entry.allowedChains)).toBeNull();
  });
});

describe('exception verification', () => {
  const check = (
    overrides: Partial<{ registry: AuditException[]; now: Date; audit: string; lock: string }> = {},
  ) =>
    checkExceptions(
      overrides.registry ?? [entry],
      overrides.now ?? beforeReview,
      overrides.audit ?? reporting,
      overrides.lock ?? lockfile(),
    );

  test('passes when the advisory reports, the chain holds, and the date is current', async () => {
    expect(await check()).toEqual([]);
  });

  test('fails on a stale exception whose advisory no longer reports', async () => {
    const problems = await check({ audit: '{}' });
    expect(problems.join('\n')).toContain('stale exception, remove it');
  });

  test('fails once the review-by date has passed', async () => {
    const problems = await check({ now: new Date('2026-11-01T00:00:00Z') });
    expect(problems.join('\n')).toContain('COR-1423');
  });

  test('fails on a malformed registry before consulting the audit', async () => {
    const problems = await check({ registry: [{ ...entry, advisory: 'nope' }] });
    expect(problems.join('\n')).toContain('not a GHSA');
  });

  test('fails on reachability outside the allowed chains', async () => {
    const problems = await check({ lock: lockfile({ rootDependencies: { other: '^1' } }) });
    expect(problems.join('\n')).toContain('reachable outside its allowed chains');
  });

  test('fails when the audit report is unreadable', async () => {
    const problems = await check({ audit: 'boom' });
    expect(problems.join('\n')).toContain('did not return a readable');
  });
});

describe('the gate', () => {
  function run(options: {
    gate?: Partial<CommandResult>;
    audit?: string;
    now?: Date;
    lock?: string;
  }) {
    const calls: (readonly string[])[] = [];
    let stdout = '';
    let stderr = '';
    const result = runAuditGate(
      {
        registry: [entry],
        now: () => options.now ?? beforeReview,
        readLockfile: async () => options.lock ?? lockfile(),
        run: async (argumentsList) => {
          calls.push(argumentsList);
          return argumentsList.includes('--json')
            ? { exitCode: 1, stdout: options.audit ?? reporting, stderr: '' }
            : { exitCode: 0, stdout: 'clean\n', stderr: '', ...options.gate };
        },
      },
      { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) },
    );
    return { result, calls, output: () => ({ stdout, stderr }) };
  }

  test('passes, ignoring exactly the registered advisories at the high level', async () => {
    const gate = run({});
    expect(await gate.result).toBe(0);
    expect(gate.calls).toContainEqual(['audit', '--audit-level=high', `--ignore=${ADVISORY}`]);
    expect(gate.output().stdout).toBe('clean\n');
  });

  test('fails on any remaining advisory, with the audit output passed through', async () => {
    const gate = run({ gate: { exitCode: 1, stdout: 'dompurify high\n' } });
    expect(await gate.result).toBe(1);
    expect(gate.output().stdout).toBe('dompurify high\n');
  });

  test('fails with a stale exception even when the audit itself is clean', async () => {
    const gate = run({ audit: '{}' });
    expect(await gate.result).toBe(1);
    expect(gate.output().stderr).toContain('stale exception');
  });

  test('fails once the review-by date has passed', async () => {
    const gate = run({ now: new Date('2026-11-01T00:00:00Z') });
    expect(await gate.result).toBe(1);
    expect(gate.output().stderr).toContain('COR-1423');
  });
});
