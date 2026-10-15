import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireGit, verifyHistoricalCheckout } from './publication-history.ts';

/**
 * COR-1534: a Cinder minor release's Version Packages commit widens a sibling's peer range on
 * Cinder. The mirror's `changeset:version` runs `reconcile-internal-peers.ts` after
 * `changeset version`, and that script rewrites a dependent's `peerDependencies` entry to
 * `^<released version>` whenever the old range no longer admits it (cinder #1606 wrote
 * `^0.26.0` → `^0.27.0`). The fixture is that history: a sync commit, then the Version Packages
 * commit, laid out as the Cinder mirror lays them out (Cinder itself at `packages/components`).
 */

type Ranges = Record<string, string>;

interface FixtureManifest {
  name: string;
  version: string;
  private?: boolean;
  exports?: Ranges;
  dependencies?: Ranges;
  devDependencies?: Ranges;
  peerDependencies?: Ranges;
}

const cinder = 'packages/components/package.json';
const editor = 'packages/editor/package.json';
const markdown = 'packages/markdown/package.json';
const mcp = 'packages/mcp/package.json';
const testing = 'packages/testing/package.json';
const deliveredChangeset = '.changeset/corvidae-24b00de8a67f-cinder-code-block-highlighter.md';

/** The workspaces as the sync leaves them. */
function syncedManifests(): Record<string, FixtureManifest> {
  return {
    [cinder]: {
      name: '@lostgradient/cinder',
      version: '0.27.1',
      dependencies: { '@lostgradient/markdown': 'workspace:*' },
      devDependencies: { '@lostgradient/testing': 'workspace:*' },
    },
    [editor]: {
      name: '@lostgradient/editor',
      version: '0.16.1',
      exports: { '.': './dist/index.js' },
      dependencies: {
        '@lostgradient/cinder': 'workspace:*',
        '@lostgradient/markdown': 'workspace:*',
      },
      devDependencies: { '@lostgradient/testing': 'workspace:*' },
      // The last three peers exist for the refusals below: a package another target publishes,
      // a workspace this target never publishes, and a third-party package.
      peerDependencies: {
        '@lostgradient/cinder': '^0.27.0',
        '@lostgradient/markdown': '^0.6.0',
        '@lostgradient/weft': '^0.27.0',
        '@lostgradient/testing': '^0.0.0',
        svelte: '>=5.56.0 <6',
      },
    },
    [markdown]: {
      name: '@lostgradient/markdown',
      version: '0.6.1',
      devDependencies: { '@lostgradient/testing': 'workspace:*' },
    },
    [mcp]: {
      name: '@lostgradient/cinder-mcp',
      version: '0.1.21',
      dependencies: { '@lostgradient/cinder': 'workspace:*' },
    },
    [testing]: { name: '@lostgradient/testing', version: '0.0.0', private: true },
  };
}

/** The exact manifests cinder's Version Packages run writes for a Cinder minor. */
function releasedManifests(): Record<string, FixtureManifest> {
  const manifests = syncedManifests();
  manifests[cinder]!.version = '0.28.0';
  manifests[editor]!.version = '0.17.0';
  manifests[editor]!.peerDependencies!['@lostgradient/cinder'] = '^0.28.0';
  manifests[mcp]!.version = '0.1.22';
  return manifests;
}

async function writeManifests(
  directory: string,
  manifests: Record<string, FixtureManifest>,
): Promise<void> {
  for (const [path, manifest] of Object.entries(manifests))
    await Bun.write(join(directory, path), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function commit(directory: string, message: string, mirror = false): Promise<string> {
  await requireGit(directory, ['add', '-A']);
  await requireGit(directory, [
    'commit',
    '--quiet',
    ...(mirror
      ? [
          '--author=lost-gradient-mirror-sync[bot] <331123939+lost-gradient-mirror-sync[bot]@users.noreply.github.com>',
        ]
      : []),
    '-m',
    message,
  ]);
  return requireGit(directory, ['rev-parse', 'HEAD']);
}

async function initialize(directory: string): Promise<void> {
  await requireGit(directory, ['init', '--quiet', '--initial-branch=main']);
  await requireGit(directory, ['config', 'user.email', 'fixture@example.test']);
  await requireGit(directory, ['config', 'user.name', 'Fixture']);
}

// The histories are built once at module scope, where no per-test clock applies.
const root = await mkdtemp(join(tmpdir(), 'publication-release-ranges-'));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const source = join(root, 'source');
const target = join(root, 'target');
await mkdir(source);
await mkdir(target);

await initialize(source);
await Bun.write(join(source, 'scripts/mirror/source.ts'), 'export const versionConstants = {};\n');
await Bun.write(
  join(source, 'scripts/mirror/target-owned.json'),
  await Bun.file(new URL('./target-owned.json', import.meta.url)).text(),
);
const sourceCommit = await commit(source, 'Historical source');

await initialize(target);
await Bun.write(
  join(target, 'package.json'),
  `${JSON.stringify({ name: 'cinder-workspace', private: true, workspaces: ['packages/*'] }, null, 2)}\n`,
);
await Bun.write(join(target, 'README.md'), 'Cinder\n');
await commit(target, 'Target base');
await writeManifests(target, syncedManifests());
await Bun.write(join(target, 'packages/components/CHANGELOG.md'), '# @lostgradient/cinder\n');
await Bun.write(join(target, 'bun.lock'), '{ "cinder": "0.27.1" }\n');
await Bun.write(
  join(target, deliveredChangeset),
  "---\n'@lostgradient/cinder': minor\n---\n\nHighlight through the context.\n",
);
const mirrorCommit = await commit(
  target,
  `Sync cinder from corvidae\n\nCorvidae-Commit: ${sourceCommit}`,
  true,
);

/**
 * A Version Packages commit on its own branch from the sync: it consumes the delivered changeset,
 * writes the changelog and lockfile, and writes `releasedManifests()` after `edit` alters them.
 */
async function versionPackages(
  branch: string,
  edit: (manifests: Record<string, FixtureManifest>) => void = () => {},
): Promise<string> {
  await requireGit(target, ['switch', '--quiet', '--create', branch, mirrorCommit]);
  const manifests = releasedManifests();
  edit(manifests);
  await writeManifests(target, manifests);
  await rm(join(target, deliveredChangeset));
  await Bun.write(
    join(target, 'packages/components/CHANGELOG.md'),
    '# @lostgradient/cinder\n\n## 0.28.0\n\n- Highlight through the context.\n',
  );
  await Bun.write(join(target, 'bun.lock'), '{ "cinder": "0.28.0" }\n');
  return commit(target, 'chore: version packages (#1610)');
}

const release = await versionPackages('release');
const releaseWithMarkdown = await versionPackages('release-with-markdown', (manifests) => {
  manifests[markdown]!.version = '0.7.0';
  manifests[editor]!.peerDependencies!['@lostgradient/markdown'] = '^0.7.0';
});

const editorPeers = `${editor}:peerDependencies`;
/**
 * Each refusal is the valid release above plus one more change, and must fail with the message the
 * recorder already gave before COR-1534: `[label, gitHead, the manifest field it names]`.
 */
const refusals: Array<[string, string, string]> = [
  [
    'a widened peer on a package another target publishes',
    await versionPackages('other-target-peer', (manifests) => {
      manifests[editor]!.peerDependencies!['@lostgradient/weft'] = '^0.28.0';
    }),
    editorPeers,
  ],
  [
    'a widened peer on a workspace the target never publishes',
    await versionPackages('private-workspace-peer', (manifests) => {
      manifests[testing]!.version = '0.0.1';
      manifests[editor]!.peerDependencies!['@lostgradient/testing'] = '^0.0.1';
    }),
    editorPeers,
  ],
  [
    'a widened peer on a third-party package',
    await versionPackages('third-party-peer', (manifests) => {
      manifests[editor]!.peerDependencies!['svelte'] = '^6.0.0';
    }),
    editorPeers,
  ],
  [
    'a widened range beyond the version the commit declares',
    await versionPackages('beyond-release', (manifests) => {
      manifests[editor]!.peerDependencies!['@lostgradient/cinder'] = '^0.29.0';
    }),
    editorPeers,
  ],
  [
    'a widened range when the commit declares no new version',
    await versionPackages('unreleased', (manifests) => {
      manifests[cinder]!.version = '0.27.1';
    }),
    editorPeers,
  ],
  [
    // It admits 0.28.0, but Changesets writes `^0.28.0`.
    'a range that admits the release in another shape',
    await versionPackages('looser-shape', (manifests) => {
      manifests[editor]!.peerDependencies!['@lostgradient/cinder'] = '>=0.27.0';
    }),
    editorPeers,
  ],
  [
    // `^0.6.0` already admits 0.6.2, so the reconciliation leaves it alone.
    'a range rewritten although the old one admitted the release',
    await versionPackages('already-admitted', (manifests) => {
      manifests[markdown]!.version = '0.6.2';
      manifests[editor]!.peerDependencies!['@lostgradient/markdown'] = '^0.6.2';
    }),
    editorPeers,
  ],
  [
    'an added peer entry',
    await versionPackages('added-peer', (manifests) => {
      manifests[editor]!.peerDependencies!['@lostgradient/cinder-mcp'] = '^0.1.22';
    }),
    editorPeers,
  ],
  [
    'a removed peer entry',
    await versionPackages('removed-peer', (manifests) => {
      delete manifests[editor]!.peerDependencies!['@lostgradient/markdown'];
    }),
    editorPeers,
  ],
  [
    'an added peerDependencies field',
    await versionPackages('added-peer-field', (manifests) => {
      manifests[mcp]!.peerDependencies = { '@lostgradient/cinder': '^0.28.0' };
    }),
    `${mcp}:peerDependencies`,
  ],
  [
    'the same widening in dependencies',
    await versionPackages('dependencies', (manifests) => {
      manifests[editor]!.dependencies!['@lostgradient/cinder'] = '^0.28.0';
    }),
    `${editor}:dependencies`,
  ],
  [
    'the same widening in devDependencies',
    await versionPackages('dev-dependencies', (manifests) => {
      manifests[editor]!.devDependencies!['@lostgradient/cinder'] = '^0.28.0';
    }),
    `${editor}:devDependencies`,
  ],
  [
    'a change to exports',
    await versionPackages('exports', (manifests) => {
      manifests[editor]!.exports!['./extra'] = './dist/extra.js';
    }),
    `${editor}:exports`,
  ],
];

/** What `verifyHistoricalCheckout` returned, or the message it refused with, for one history. */
type Outcome = { certified: string } | { refused: string };

async function verify(gitHead: string): Promise<Outcome> {
  try {
    return {
      certified: await verifyHistoricalCheckout({
        sourceRoot: source,
        targetRoot: target,
        target: 'cinder',
        workspace: '@lostgradient/cinder',
        targetDirectory: 'packages/components',
        mirrorCommit,
        gitHead,
      }),
    };
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
}

// Each walk runs dozens of child processes, so the walks run here too, one at a time, and the
// tests assert on what they recorded.
const outcomes = new Map<string, Outcome>();
for (const gitHead of [release, releaseWithMarkdown, ...refusals.map(([, gitHead]) => gitHead)])
  outcomes.set(gitHead, await verify(gitHead));

test('accepts a Version Packages commit that widens a sibling peer on the released Cinder', () => {
  expect(outcomes.get(release)).toEqual({ certified: sourceCommit });
});

test('accepts widening every sibling peer the same release bumps', () => {
  expect(outcomes.get(releaseWithMarkdown)).toEqual({ certified: sourceCommit });
});

test.each(refusals)('refuses %s', (_label, gitHead, field) => {
  expect(outcomes.get(gitHead)).toEqual({
    refused: `Intervening commit ${gitHead} changes source-owned manifest field ${field}`,
  });
});
