import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { SHARED_BUILD_OPTIONS } from './build-artifacts-shared.ts';
import {
  CINDER_PACKAGE_NAME,
  CINDER_PACKAGE_VERSION_MODULE,
  CinderPackageVersionError,
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
const publishedVersion = await readLastPublishedVersion(CINDER_PACKAGE_NAME);

// The bundle is built at module scope, untimed: the tests only assert on what it produced.
await mkdir(PLAYGROUND_TEMP_ROOT, { recursive: true });
const scratch = await mkdtemp(join(PLAYGROUND_TEMP_ROOT, 'cinder-package-version-'));
const entry = join(scratch, 'entry.ts');
await Bun.write(entry, "export { CINDER_BASE } from '@lostgradient/cinder/tokens/runtime';\n");
const bundle = await Bun.build({
  entrypoints: [entry],
  publicPath: '/cinder-package-version/',
  ...SHARED_BUILD_OPTIONS,
  splitting: false,
});
const bundled = join(scratch, 'bundled.js');
await Bun.write(bundled, await bundle.outputs[0]!.text());
const { CINDER_BASE: bundledBase } = (await import(bundled)) as {
  CINDER_BASE: { packageVersion: string; sourceDigest: string };
};

afterAll(() => rm(scratch, { recursive: true, force: true }));

describe('the Playground bundles Cinder with its published version (COR-231)', () => {
  test('the package map records a published Cinder version', () => {
    expect(publishedVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('a bundled token runtime reports that version, never the `workspace` sentinel', async () => {
    expect(bundle.success).toBe(true);
    expect(bundledBase.packageVersion).toBe(publishedVersion!);
    expect(bundledBase.packageVersion).not.toBe('workspace');
    // The stamp rewrites the version only: the digest still names the workspace corpus.
    const { CINDER_BASE } = await import('@lostgradient/cinder/tokens/runtime');
    expect(bundledBase.sourceDigest).toBe(CINDER_BASE.sourceDigest);
  });

  test('the workspace source itself keeps the sentinel the mirror rewrites', () => {
    expect(generatedModule).toContain("export const VERSION = 'workspace';\n");
    expect(CINDER_PACKAGE_VERSION_MODULE.test(generatedModulePath)).toBe(true);
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

  test.each(["1.0.0'; alert(1); '", 'workspace', '1.0', ''])(
    'refuses %p as a version',
    (version) => {
      expect(() => stampPackageVersion(generatedModule, version)).toThrow(
        'is not a release version',
      );
    },
  );
});
