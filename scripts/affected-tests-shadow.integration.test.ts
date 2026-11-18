import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { runWithHangGuard } from '../testing/testing/src/hang-guard.ts';
import { selectTests } from './affected-tests-selection.ts';
import {
  classifyFailureRecords,
  normalizeJobLog,
  omittedFailures,
  replayRevision,
  selectionAtRevision,
  shadowRun,
  workspacesAtRevision,
} from './affected-tests-shadow.ts';
import { discoverWorkspaces, listTree } from './affected-tests.ts';
import { failureRecords } from './chef/ci-compare.ts';

async function fixtureGit(repository: string, args: string[]) {
  const result = await runWithHangGuard(['git', '-C', repository, ...args]);
  if (result.exitCode !== 0)
    throw new Error(`fixture git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** Create commits the shadow entrypoints can resolve without relying on repository history. */
async function createShadowFixture() {
  const scratch = join(process.cwd(), 'tmp/chef/p06-14ef');
  await mkdir(scratch, { recursive: true });
  const repository = await mkdtemp(join(scratch, 'affected-tests-shadow-'));
  const write = async (path: string, contents: string) => {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), contents);
  };
  await write(
    'package.json',
    `${JSON.stringify({ name: 'shadow-fixture', workspaces: ['components/*'] })}\n`,
  );
  await write(
    'components/cinder/package.json',
    `${JSON.stringify({
      name: '@lostgradient/cinder',
      exports: { '.': './src/index.ts' },
      scripts: { test: 'bun test --preload scripts/preload.ts src/index.test.ts' },
    })}\n`,
  );
  await write('components/cinder/src/index.ts', 'export const fixture = true;\n');
  await write('components/cinder/src/index.test.ts', "import { fixture } from './index.ts';\n");
  await write('components/cinder/scripts/preload.ts', 'export {};\n');
  await fixtureGit(repository, ['init', '--quiet']);
  await fixtureGit(repository, ['config', 'user.email', 'shadow-fixture@example.invalid']);
  await fixtureGit(repository, ['config', 'user.name', 'Shadow fixture']);
  await fixtureGit(repository, ['add', '.']);
  await fixtureGit(repository, ['commit', '--quiet', '-m', 'fixture source']);
  const frozenRevision = await fixtureGit(repository, ['rev-parse', 'HEAD']);
  await write('fixture-revision.txt', 'second immutable fixture revision\n');
  await fixtureGit(repository, ['add', 'fixture-revision.txt']);
  await fixtureGit(repository, ['commit', '--quiet', '-m', 'fixture marker']);
  return {
    repository,
    frozenRevision,
    fixtureRevision: await fixtureGit(repository, ['rev-parse', 'HEAD']),
  };
}

const shadowFixture = await createShadowFixture();
const { frozenRevision } = shadowFixture;
const liveWorkspaces = discoverWorkspaces(shadowFixture.repository);
const immutableWorkspaces = workspacesAtRevision(
  shadowFixture.repository,
  shadowFixture.fixtureRevision,
);
const preloadChange = ['components/cinder/scripts/preload.ts'];
const immutablePreloadSelection = selectionAtRevision(
  shadowFixture.repository,
  shadowFixture.fixtureRevision,
  preloadChange,
);
const livePreloadSelection = selectTests({
  changed: preloadChange,
  tree: listTree(shadowFixture.repository),
  workspaces: liveWorkspaces,
});
type ProviderControl = {
  status: string;
  conclusion?: string;
  jobs: { status: string; conclusion?: string }[];
};
const incompleteProviderCases: ProviderControl[] = [
  { status: 'in_progress', jobs: [] },
  {
    status: 'completed',
    conclusion: 'cancelled',
    jobs: [{ status: 'completed', conclusion: 'cancelled' }],
  },
  { status: 'completed', conclusion: 'success', jobs: [] },
  { status: 'completed', conclusion: 'success', jobs: [{ status: 'in_progress' }] },
  {
    status: 'completed',
    conclusion: 'failure',
    jobs: [{ status: 'completed', conclusion: 'success' }],
  },
  {
    status: 'completed',
    conclusion: 'success',
    jobs: [{ status: 'completed', conclusion: 'failure' }],
  },
];
const incompleteRouteDispositions = incompleteProviderCases.map((provider) => ({
  replay: replayRevision(shadowFixture.repository, {
    name: 'provider control',
    revision: frozenRevision,
    base: frozenRevision,
    provider,
  }).disposition,
  baseline: shadowRun(shadowFixture.repository, {
    frozenSample: {
      headSha: frozenRevision,
      status: provider.status,
      ...(provider.conclusion === undefined ? {} : { conclusion: provider.conclusion }),
    },
    jobs: provider.jobs,
    gitInputs: { changedPaths: [] },
  }).disposition,
}));
const failedProvider = {
  status: 'completed',
  conclusion: 'failure',
  jobs: [{ name: 'Root typecheck', status: 'completed', conclusion: 'failure' }],
};
const stepOnlyReplay = replayRevision(shadowFixture.repository, {
  name: 'step-only public replay control',
  revision: frozenRevision,
  base: frozenRevision,
  provider: failedProvider,
  failureLog: join(import.meta.dir, 'chef/fixtures/shadow-step-only-failure.log'),
});
const mixedReplay = replayRevision(shadowFixture.repository, {
  name: 'mixed public replay control',
  revision: frozenRevision,
  base: frozenRevision,
  provider: failedProvider,
  failureLog: join(import.meta.dir, 'chef/fixtures/shadow-step-and-test-failure.log'),
});
const failedBaseline = shadowRun(shadowFixture.repository, {
  frozenSample: { headSha: frozenRevision, status: 'completed', conclusion: 'failure' },
  jobs: failedProvider.jobs,
  gitInputs: { changedPaths: [] },
});

// The replay opens Git objects. Run that real process work at module scope so the test callback
// only asserts its recorded result, independent of the per-test clock.
const entrypointReplay = replayRevision(shadowFixture.repository, {
  name: 'entrypoint control',
  revision: shadowFixture.fixtureRevision,
  base: shadowFixture.fixtureRevision,
  provider: {
    status: 'completed',
    conclusion: 'success',
    jobs: [{ status: 'completed', conclusion: 'success' }],
  },
});
const mutableReferenceError = (() => {
  try {
    replayRevision(shadowFixture.repository, {
      name: 'mutable reference control',
      revision: 'HEAD',
      base: 'HEAD',
      provider: { jobs: [] },
    });
  } catch (error) {
    return error as Error;
  }
  throw new Error('mutable reference unexpectedly replayed');
})();
const mutableBaselineError = (() => {
  try {
    shadowRun(shadowFixture.repository, {
      frozenSample: { headSha: 'HEAD', status: 'completed' },
      jobs: [{}],
      gitInputs: { changedPaths: [] },
    });
  } catch (error) {
    return error as Error;
  }
  throw new Error('mutable baseline unexpectedly replayed');
})();

describe('shadow failure accounting', () => {
  test('normalizes the retained provider job log for the shared failure extractor', () => {
    // Representative timestamp-prefixed lines retained from the authenticated P10 job log.
    const log = [
      '2026-11-18T03:58:11Z ##[group]Run bun run test:slow',
      '2026-11-18T03:58:11Z ##[group]@lostgradient/evaluation:test:slow',
      '2026-11-18T03:58:11Z ##[group]src/host/remote-persistence-conformance.slow.test.ts:',
      '2026-11-18T03:58:11Z error: expect(received).toBeGreaterThanOrEqual(expected)',
      '2026-11-18T03:58:11Z Expected: >= 2',
    ].join('\n');
    const identities = [
      ...failureRecords(normalizeJobLog('Slow and integration tests', log)).values(),
    ]
      .flatMap((records) => records)
      .flatMap((record) => (record.identity === undefined ? [] : [record.identity]));
    expect(identities.join('\n')).toContain('remote-persistence-conformance.slow.test.ts');
  });

  test('records an attributable selected failure without an omission', () => {
    expect(
      omittedFailures(
        ['applications/interborough/src/host/remote-persistence-conformance.slow.test.ts'],
        [
          '@lostgradient/interborough › src/host/remote-persistence-conformance.slow.test.ts › OAuth attempts',
        ],
        [
          {
            name: '@lostgradient/interborough',
            directory: 'applications/interborough',
            dependencies: [],
            exports: null,
            preloads: [],
            testScripts: [],
          },
        ],
      ),
    ).toEqual([]);
  });

  test('reports a deliberately excluded attributable failure as an omission', () => {
    expect(
      omittedFailures(
        [],
        [
          '@lostgradient/interborough › src/host/remote-persistence-conformance.slow.test.ts › OAuth attempts',
        ],
        [
          {
            name: '@lostgradient/interborough',
            directory: 'applications/interborough',
            dependencies: [],
            exports: null,
            preloads: [],
            testScripts: [],
          },
        ],
        ['applications/interborough/src/host/remote-persistence-conformance.slow.test.ts'],
      ),
    ).toEqual([
      '@lostgradient/interborough › src/host/remote-persistence-conformance.slow.test.ts › OAuth attempts',
    ]);
  });

  test('does not turn absent failure evidence into a miss', () => {
    expect(
      omittedFailures(
        ['scripts/a.test.ts'],
        [],
        [
          {
            name: 'root',
            directory: '',
            dependencies: [],
            exports: null,
            preloads: [],
            testScripts: [],
          },
        ],
      ),
    ).toEqual([]);
  });

  test('serializes known, residual unknown, and missing provider evidence distinctly', () => {
    const known = classifyFailureRecords(
      ['src/a.test.ts'],
      [{ kind: 'test', job: 'tests', identity: 'root › src/a.test.ts › assertion' }],
      ['tests'],
      [
        {
          name: 'root',
          directory: '',
          dependencies: [],
          exports: null,
          preloads: [],
          testScripts: [],
        },
      ],
    );
    expect(known).toMatchObject({ omittedFailures: [], unclassifiedFailures: [] });
    expect(
      classifyFailureRecords([], [{ kind: 'unknown', job: 'tests' }], ['tests'], [])
        .unclassifiedFailures,
    ).toHaveLength(1);
    expect(classifyFailureRecords([], [], ['tests'], []).unclassifiedFailures).toHaveLength(1);
  });

  test('replays a revision through the supported entrypoint without a stale selection reference', () => {
    expect(entrypointReplay.changed).toEqual([]);
    expect(entrypointReplay.selected).toEqual([]);
    expect(entrypointReplay.omittedFailures).toEqual([]);
  });

  test('rejects mutable revision references before replaying evidence', () => {
    expect(mutableReferenceError.message).toContain('exact 40-hex commit SHA');
    expect(mutableBaselineError.message).toContain('exact 40-hex commit SHA');
  });

  test('keeps immutable discovery equal to the live exports and preload snapshot', () => {
    const liveCinder = liveWorkspaces.find(
      (workspace) => workspace.name === '@lostgradient/cinder',
    );
    const immutableCinder = immutableWorkspaces.find(
      (workspace) => workspace.name === '@lostgradient/cinder',
    );
    expect(immutableCinder).toEqual(liveCinder);
    expect(
      immutablePreloadSelection.workspaces.flatMap((workspace) => [...workspace.tests.keys()])
        .length,
    ).toBe(
      livePreloadSelection.workspaces.flatMap((workspace) => [...workspace.tests.keys()]).length,
    );
  });

  test('does not correlate same basenames or substring filenames across workspace identities', () => {
    const workspaces = [
      {
        name: '@lostgradient/evaluation',
        directory: 'testing/evaluation',
        dependencies: [],
        exports: null,
        preloads: [],
        testScripts: [],
      },
      {
        name: '@lostgradient/bureau',
        directory: 'packages/bureau',
        dependencies: [],
        exports: null,
        preloads: [],
        testScripts: [],
      },
    ];
    const selected = [
      'testing/evaluation/src/admission.test.ts',
      'testing/evaluation/src/oauth.test.ts',
    ];
    expect(
      omittedFailures(
        selected,
        ['@lostgradient/bureau › test/skills/client/admission.test.ts › failure'],
        workspaces,
        ['packages/bureau/test/skills/client/admission.test.ts'],
      ),
    ).toHaveLength(1);
    expect(
      omittedFailures(
        selected,
        ['@lostgradient/evaluation › src/auth.test.ts › failure'],
        workspaces,
        ['testing/evaluation/src/auth.test.ts'],
      ),
    ).toHaveLength(1);
    expect(
      classifyFailureRecords(
        selected,
        [{ kind: 'test', job: 'tests', identity: 'admission.test.ts › failure' }],
        ['tests'],
        workspaces,
      ).unclassifiedFailures,
    ).toHaveLength(1);
    const sameRelativePath = '@lostgradient/bureau › src/index.test.ts › failure';
    const fullInventory = [
      'testing/evaluation/src/index.test.ts',
      'packages/bureau/src/index.test.ts',
    ];
    expect(
      omittedFailures(
        ['testing/evaluation/src/index.test.ts'],
        [sameRelativePath],
        workspaces,
        fullInventory,
      ),
    ).toEqual([sameRelativePath]);
  });

  test('keeps incomplete provider evidence inconclusive through both public routes', () => {
    expect(incompleteRouteDispositions).toEqual(
      Array.from({ length: incompleteProviderCases.length }, () => ({
        replay: 'inconclusive',
        baseline: 'inconclusive',
      })),
    );
  });

  test('retains non-test steps and mixed test records through public replay routes', () => {
    expect(stepOnlyReplay).toMatchObject({ disposition: 'inconclusive', attributedFailures: [] });
    expect(stepOnlyReplay.unclassifiedFailures).toContainEqual(
      expect.objectContaining({ job: 'Root typecheck', reason: 'TypeScript typecheck failed' }),
    );
    expect(mixedReplay.attributedFailures).toHaveLength(1);
    expect(mixedReplay.unclassifiedFailures).toContainEqual(
      expect.objectContaining({ job: 'Root typecheck', reason: 'TypeScript typecheck failed' }),
    );
    expect(failedBaseline).toMatchObject({
      disposition: 'inconclusive',
      fullRunFailures: ['Root typecheck'],
    });
  });
});
