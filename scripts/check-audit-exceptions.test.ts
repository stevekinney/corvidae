import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditException } from './audit-exceptions';
import { auditExceptions } from './audit-exceptions';
import {
  buildGraph,
  checkExceptions,
  createRepositoryDependencies,
  findExpiredExceptions,
  findUnauthorizedPaths,
  parseAdvisories,
  repositoryRoot,
  runAuditGate,
  validateRegistry,
  type CommandResult,
} from './check-audit-exceptions';

const ADVISORY = 'GHSA-vfj7-8cjw-p6xm';
const entry: AuditException = {
  advisory: ADVISORY,
  package: 'braces',
  allowedChains: [['ui', 'stylelint', 'micromatch', 'braces']],
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

/** Replaces `from` with `to`, failing loudly when the fixture no longer contains `from`. */
function substitute(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`fixture does not contain ${from}`);
  return text.replace(from, to);
}

const STYLELINT_ENTRY =
  '"stylelint": ["stylelint@1.0.0", "", { "dependencies": { "micromatch": "^4" } }, "sha"],';
const BRACES_ENTRY = '"braces": ["braces@3.0.3", "", {}, "sha"],';

/** Stylelint gains a second route to `braces`, through a helper the exception never named. */
function withNewStylelintRoute(text: string): string {
  return substitute(
    text,
    STYLELINT_ENTRY,
    `"stylelint": ["stylelint@1.0.0", "", { "dependencies": { "micromatch": "^4", "new-helper": "^1" } }, "sha"],
      "new-helper": ["new-helper@1.0.0", "", { "dependencies": { "braces": "^3" } }, "sha"],`,
  );
}

/** A second installed `braces` that no package depends on, so no workspace can reach it. */
function withOrphanedInstance(text: string): string {
  return substitute(
    text,
    BRACES_ENTRY,
    `${BRACES_ENTRY}
      "orphan/braces": ["braces@3.0.2", "", {}, "sha"],`,
  );
}

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

  test.each([
    ['stops short of the vulnerable package', [['ui', 'stylelint']]],
    [
      'runs past the vulnerable package',
      [['ui', 'stylelint', 'micromatch', 'braces', 'fill-range']],
    ],
    [
      'names another package than the vulnerable one',
      [['ui', 'stylelint', 'micromatch', 'picomatch']],
    ],
  ] as const)('rejects a chain that %s', (_label, allowedChains) => {
    const problems = validateRegistry([{ ...entry, allowedChains }]).join('\n');
    expect(problems).toContain('must end at the vulnerable package "braces"');
  });

  test('accepts a chain that runs from the importer to the vulnerable package', () => {
    expect(validateRegistry([entry])).toEqual([]);
  });

  test('requires every chain of the shipped registry to end at its vulnerable package', () => {
    expect(auditExceptions.length).toBeGreaterThan(0);
    for (const shipped of auditExceptions) {
      for (const chain of shipped.allowedChains) {
        expect(chain.at(-1)).toBe(shipped.package);
      }
    }
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

  test('reports an absent package as null', () => {
    expect(findUnauthorizedPaths(buildGraph(lockfile()), 'absent', entry.allowedChains)).toBeNull();
  });

  const withOther = (otherMetadata: string) =>
    lockfile({ rootDependencies: { other: '^1' } }).replace(
      '"other": ["other@1.0.0", "", { "dependencies": { "micromatch": "^4" } }, "sha"]',
      `"other": ["other@1.0.0", "", ${otherMetadata}, "sha"]`,
    );

  test('treats a required peer dependency of a runtime package as a path', () => {
    const graph = buildGraph(withOther('{ "peerDependencies": { "micromatch": "^4" } }'));
    expect(findUnauthorizedPaths(graph, 'braces', entry.allowedChains)).toEqual([
      'root > other > micromatch > braces',
    ]);
  });

  test('ignores a peer dependency the lockfile lists as optional', () => {
    const graph = buildGraph(
      withOther('{ "peerDependencies": { "micromatch": "^4" }, "optionalPeers": ["micromatch"] }'),
    );
    expect(findUnauthorizedPaths(graph, 'braces', entry.allowedChains)).toEqual([]);
    expect(
      buildGraph(withOther('{ "peerDependencies": { "micromatch": "^4" } }')).edges,
    ).not.toEqual(graph.edges);
  });

  test('ignores a peer dependency marked optional in peerDependenciesMeta', () => {
    const graph = buildGraph(
      withOther(
        '{ "peerDependencies": { "micromatch": "^4" }, "peerDependenciesMeta": { "micromatch": { "optional": true } } }',
      ),
    );
    expect(findUnauthorizedPaths(graph, 'braces', entry.allowedChains)).toEqual([]);
  });

  test('classifies a workspace peer dependency as runtime, not development', () => {
    const peer = lockfile({ uiDevelopment: {} }).replace(
      '"dependencies": {}, },',
      '"peerDependencies": { "stylelint": "^1" }, },',
    );
    const paths = findUnauthorizedPaths(buildGraph(peer), 'braces', entry.allowedChains) ?? [];
    expect(paths).toContain('ui > stylelint > micromatch > braces');
  });

  test('ignores an optional peer dependency of a workspace', () => {
    const peer = lockfile({ uiDevelopment: {} }).replace(
      '"dependencies": {}, },',
      '"peerDependencies": { "stylelint": "^1" }, "optionalPeers": ["stylelint"], },',
    );
    const paths = findUnauthorizedPaths(buildGraph(peer), 'braces', entry.allowedChains) ?? [];
    expect(paths.filter((path) => path.includes(' > '))).toEqual([]);
  });

  test('fails closed when the package is installed but no workspace reaches it', () => {
    const orphan = lockfile({ uiDevelopment: { unrelated: '^1' } });
    const paths = findUnauthorizedPaths(buildGraph(orphan), 'braces', entry.allowedChains);
    expect(paths?.join('\n')).toContain('not reachable from any workspace');
  });

  test('reports a workspace missing from the lockfile packages', async () => {
    const broken = lockfile().replace('"ui": ["ui@workspace:components/ui"],', '');
    const problems = await checkExceptions([entry], beforeReview, reporting, broken);
    expect(problems.join('\n')).toContain('workspace "ui" not found in lockfile packages');
  });

  describe('a route the exception never named', () => {
    const lock = withNewStylelintRoute(lockfile());
    const graph = buildGraph(lock);

    test('is reported even though it runs through the allowed importer and Stylelint', () => {
      const paths = findUnauthorizedPaths(graph, 'braces', entry.allowedChains) ?? [];
      expect(paths.toSorted()).toEqual([
        'app > ui > stylelint > new-helper > braces',
        'root > app > ui > stylelint > new-helper > braces',
        'ui > stylelint > new-helper > braces',
      ]);
    });

    test('is reported, and so is every other route, when the chain stops short of the package', () => {
      const paths = findUnauthorizedPaths(graph, 'braces', [['ui', 'stylelint']]) ?? [];
      expect(paths).toContain('ui > stylelint > new-helper > braces');
      expect(paths).toContain('ui > stylelint > micromatch > braces');
    });

    test('fails the exception check', async () => {
      const problems = await checkExceptions([entry], beforeReview, reporting, lock);
      expect(problems.join('\n')).toContain('ui > stylelint > new-helper > braces.');
    });

    test('is accepted once its full path is an allowed chain', () => {
      const chains = [...entry.allowedChains, ['ui', 'stylelint', 'new-helper', 'braces']];
      expect(findUnauthorizedPaths(graph, 'braces', chains)).toEqual([]);
    });
  });

  describe('a second installed instance', () => {
    test('that no workspace reaches is reported although another instance is reachable', () => {
      const graph = buildGraph(withOrphanedInstance(lockfile()));
      expect(findUnauthorizedPaths(graph, 'braces', entry.allowedChains)).toEqual([
        'orphan/braces is installed but not reachable from any workspace; the lockfile graph cannot explain it',
      ]);
    });

    test('that no workspace reaches fails the gate despite the advisory-wide ignore', async () => {
      const problems = await checkExceptions(
        [entry],
        beforeReview,
        reporting,
        withOrphanedInstance(lockfile()),
      );
      expect(problems.join('\n')).toContain('orphan/braces is installed but not reachable');
    });

    test('is accepted when an allowed chain reaches it too', () => {
      const nested = substitute(
        lockfile({ rootDependencies: { other: '^1' } }),
        '"other": ["other@1.0.0", "", { "dependencies": { "micromatch": "^4" } }, "sha"],',
        `"other": ["other@1.0.0", "", { "dependencies": { "micromatch": "^4" } }, "sha"],
      "other/micromatch": ["micromatch@4.0.8", "", { "dependencies": { "braces": "^3" } }, "sha"],
      "other/micromatch/braces": ["braces@3.0.2", "", {}, "sha"],`,
      );
      const graph = buildGraph(nested);
      const chains = [...entry.allowedChains, ['root', 'other', 'micromatch', 'braces']];
      expect(findUnauthorizedPaths(graph, 'braces', chains)).toEqual([]);
      expect(findUnauthorizedPaths(graph, 'braces', entry.allowedChains)).toEqual([
        'root > other > micromatch > braces',
      ]);
    });
  });
});

describe('the shipped braces exception', () => {
  const shipped = auditExceptions.find((candidate) => candidate.package === 'braces');
  if (shipped === undefined) throw new Error('the shipped registry has no braces exception');

  /** The workspaces and importers the shipped chains name, with Stylelint reaching `braces`. */
  const shippedShape = (stylelintDependencies: string) => `{
    "lockfileVersion": 1,
    "workspaces": {
      "": { "name": "corvidae", "devDependencies": { "stylelint": "^1", "stylelint-use-logical": "^2" }, },
      "components/cinder": { "name": "@lostgradient/cinder", "devDependencies": { "stylelint": "^1" }, },
    },
    "packages": {
      "@lostgradient/cinder": ["@lostgradient/cinder@workspace:components/cinder"],
      "stylelint": ["stylelint@1.0.0", "", { "dependencies": ${stylelintDependencies} }, "sha"],
      "stylelint-use-logical": ["stylelint-use-logical@2.0.0", "", { "peerDependencies": { "stylelint": "^1" } }, "sha"],
      "micromatch": ["micromatch@4.0.8", "", { "dependencies": { "braces": "^3" } }, "sha"],
      "new-helper": ["new-helper@1.0.0", "", { "dependencies": { "braces": "^3" } }, "sha"],
      "braces": ["braces@3.0.3", "", {}, "sha"],
    },
  }`;

  test('accepts the route Stylelint has through micromatch', () => {
    const graph = buildGraph(shippedShape('{ "micromatch": "^4" }'));
    expect(findUnauthorizedPaths(graph, 'braces', shipped.allowedChains)).toEqual([]);
  });

  test('rejects a route Stylelint gains through a package the exception never named', () => {
    const graph = buildGraph(shippedShape('{ "micromatch": "^4", "new-helper": "^1" }'));
    const paths = findUnauthorizedPaths(graph, 'braces', shipped.allowedChains) ?? [];
    expect(paths.toSorted()).toEqual([
      '@lostgradient/cinder > stylelint > new-helper > braces',
      'corvidae > stylelint > new-helper > braces',
      'corvidae > stylelint-use-logical > stylelint > new-helper > braces',
    ]);
  });
});

describe('repository root anchoring', () => {
  test('reads the lockfile and runs bun in the repository root from any directory', async () => {
    const original = process.cwd();
    const elsewhere = mkdtempSync(join(tmpdir(), 'audit-guard-'));
    try {
      process.chdir(elsewhere);
      const dependencies = createRepositoryDependencies();
      expect(await dependencies.readLockfile()).toBe(
        await Bun.file(join(repositoryRoot, 'bun.lock')).text(),
      );
      const result = await dependencies.run(['-e', 'console.log(process.cwd())']);
      expect(realpathSync(result.stdout.trim())).toBe(realpathSync(repositoryRoot));
    } finally {
      process.chdir(original);
      rmSync(elsewhere, { recursive: true, force: true });
    }
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

  test('fails when a second installed instance is reachable from no workspace', async () => {
    const gate = run({ lock: withOrphanedInstance(lockfile()) });
    expect(await gate.result).toBe(1);
    expect(gate.output().stderr).toContain('orphan/braces is installed but not reachable');
  });

  test('fails when Stylelint gains a route the exception never named', async () => {
    const gate = run({ lock: withNewStylelintRoute(lockfile()) });
    expect(await gate.result).toBe(1);
    expect(gate.output().stderr).toContain('ui > stylelint > new-helper > braces');
  });
});
