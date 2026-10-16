import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { CINDER_BASE } from '@lostgradient/cinder/tokens/runtime';

import { SHARED_BUILD_OPTIONS } from './build-artifacts-shared.ts';
import {
  CINDER_PACKAGE_NAME,
  CINDER_PACKAGE_VERSION_MODULE,
  CinderPackageVersionError,
  cinderPackageVersionPlugin,
  type CinderPackageVersionSources,
  publishedVersionForBase,
  readBundledBaseDigest,
  readPublishedBases,
  stampPackageVersion,
} from './cinder-package-version-plugin.ts';
import { CINDER_COMPONENT_SOURCE } from './component-sources.ts';
import { PLAYGROUND_TEMP_ROOT } from './playground-paths.ts';
import { readLastPublishedVersion } from './published-version.ts';

const generatedModulePath = join(
  CINDER_COMPONENT_SOURCE.packageRoot,
  'src',
  'tokens',
  'runtime',
  'package-version.generated.ts',
);
const generatedModule = await Bun.file(generatedModulePath).text();
const lastPublishedVersion = await readLastPublishedVersion(CINDER_PACKAGE_NAME);
const publishedBases = await readPublishedBases();
const otherDigest = `sha256:${'0'.repeat(64)}`;

// The bundles are built at module scope, untimed: the tests only assert on what they produced.
await mkdir(PLAYGROUND_TEMP_ROOT, { recursive: true });
const scratch = await mkdtemp(join(PLAYGROUND_TEMP_ROOT, 'cinder-package-version-'));
const entry = join(scratch, 'entry.ts');
await Bun.write(entry, "export { CINDER_BASE } from '@lostgradient/cinder/tokens/runtime';\n");

type BundledBase = { packageVersion: string; sourceDigest: string };

/** Bundle the token runtime with the shared options, optionally stamping from `sources`. */
async function bundledBase(name: string, sources?: CinderPackageVersionSources) {
  const plugins = SHARED_BUILD_OPTIONS.plugins.map((plugin) =>
    sources !== undefined && plugin.name === 'cinder-package-version'
      ? cinderPackageVersionPlugin(sources)
      : plugin,
  );
  const result = await Bun.build({
    entrypoints: [entry],
    publicPath: '/cinder-package-version/',
    ...SHARED_BUILD_OPTIONS,
    plugins,
    splitting: false,
  });
  const output = join(scratch, `${name}.js`);
  await Bun.write(output, await result.outputs[0]!.text());
  const module = (await import(output)) as { CINDER_BASE: BundledBase };
  return { success: result.success, base: module.CINDER_BASE };
}

const releasedAs = (digest: string): CinderPackageVersionSources => ({
  lastPublishedVersion: async () => '9.8.7',
  publishedBases: async () => ({ '9.8.7': digest }),
});
const recorded = await bundledBase('recorded');
const released = await bundledBase('released', releasedAs(CINDER_BASE.sourceDigest));
const unreleased = await bundledBase('unreleased', releasedAs(otherDigest));

afterAll(() => rm(scratch, { recursive: true, force: true }));

describe('the Playground bundles Cinder with the release its base belongs to (COR-231)', () => {
  test('a base the release ships is stamped with that release, digest untouched', () => {
    expect(released.success).toBe(true);
    expect(released.base.packageVersion).toBe('9.8.7');
    expect(released.base.sourceDigest).toBe(CINDER_BASE.sourceDigest);
  });

  test('a base the release does not ship keeps the `workspace` sentinel', () => {
    expect(unreleased.success).toBe(true);
    expect(unreleased.base.packageVersion).toBe('workspace');
    expect(unreleased.base.sourceDigest).toBe(CINDER_BASE.sourceDigest);
  });

  test('the shared build options stamp from the recorded release', () => {
    expect(recorded.success).toBe(true);
    expect(recorded.base.packageVersion).toBe(
      publishedVersionForBase(CINDER_BASE.sourceDigest, lastPublishedVersion!, publishedBases) ??
        'workspace',
    );
  });

  test('the workspace source itself keeps the sentinel the mirror rewrites', () => {
    expect(generatedModule).toContain("export const VERSION = 'workspace';\n");
    expect(CINDER_PACKAGE_VERSION_MODULE.test(generatedModulePath)).toBe(true);
  });

  test('the digest the stamp compares is the one the runtime ships', async () => {
    expect(await readBundledBaseDigest(generatedModulePath)).toBe(CINDER_BASE.sourceDigest);
  });
});

describe('cinder-published-bases.json', () => {
  test('records a base digest for the last published Cinder version', () => {
    expect(lastPublishedVersion).toBeDefined();
    expect(Object.keys(publishedBases)).toContain(lastPublishedVersion!);
  });

  test('records SemVer versions and sha256 digests only', () => {
    for (const [version, digest] of Object.entries(publishedBases)) {
      expect(() => stampPackageVersion(generatedModule, version)).not.toThrow();
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });
});

describe('publishedVersionForBase', () => {
  const bases = { '1.0.0': CINDER_BASE.sourceDigest };

  test('names the release whose base matches, and nothing otherwise', () => {
    expect(publishedVersionForBase(CINDER_BASE.sourceDigest, '1.0.0', bases)).toBe('1.0.0');
    expect(publishedVersionForBase(otherDigest, '1.0.0', bases)).toBeUndefined();
  });

  test('refuses a release with no recorded digest', () => {
    expect(() => publishedVersionForBase(CINDER_BASE.sourceDigest, '2.0.0', bases)).toThrow(
      'records no base digest for @lostgradient/cinder@2.0.0',
    );
  });
});

describe('stampPackageVersion', () => {
  test('rewrites the one literal and keeps the leading comment', () => {
    const stamped = stampPackageVersion(generatedModule, '1.2.3-rc.1+build.5');
    expect(stamped).toBe(generatedModule.replace("'workspace'", "'1.2.3-rc.1+build.5'"));
  });

  test('refuses a module of any other shape', () => {
    expect(() =>
      stampPackageVersion(`${generatedModule}export const OTHER = 1;\n`, '1.0.0'),
    ).toThrow(CinderPackageVersionError);
    expect(() => stampPackageVersion('export const VERSION = "workspace";\n', '1.0.0')).toThrow(
      'is not shaped as',
    );
  });

  test.each([
    "1.0.0'; alert(1); '",
    'workspace',
    '1.0',
    '',
    '01.2.3',
    '1.2.3-alpha..1',
    '1.2.3-01',
  ])('refuses %p as a version', (version) => {
    expect(() => stampPackageVersion(generatedModule, version)).toThrow('is not a release version');
  });
});
