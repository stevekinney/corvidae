/**
 * Stamps the published `@lostgradient/cinder` version into the token runtime the Playground
 * bundles (COR-231).
 *
 * Cinder's `package-version.generated.ts` holds the sentinel `workspace`, because the workspace
 * carries no version; the mirror rewrites that one literal when it composes the package
 * (`versionConstants` in `scripts/mirror/source.ts`). The Playground compiles Cinder's source
 * directly, so without this stamp every theme the deployed theme builder exported named its base
 * `workspace`. The stamp applies the same rewrite at bundle time, from the version
 * `scripts/mirror/package-map.json` records as last published, which is also the version the
 * documentation displays. The source digest is a separate generated file and is untouched.
 */

import type { BunPlugin } from 'bun';

import { readLastPublishedVersion } from './published-version.ts';

export const CINDER_PACKAGE_NAME = '@lostgradient/cinder';

/** The generated module the mirror's `versionConstants` names for Cinder, matched by its suffix. */
export const CINDER_PACKAGE_VERSION_MODULE =
  /[\\/]tokens[\\/]runtime[\\/]package-version\.generated\.ts$/;

/** The one shape the mirror's rewrite accepts: any leading comment, then the export. */
const versionExportShape = /^([\s\S]*?)export const VERSION = '([^']*)';\n$/;

/**
 * A SemVer 2.0 version, using the ECMAScript-compatible expression published by
 * https://semver.org/: the same grammar as the mirror's `isSafeVersionConstant`, so the stamp
 * accepts nothing the mirror's rewrite would refuse. It also excludes quotes, backslashes and
 * line breaks, so the version is safe to embed as a single-quoted literal.
 */
const releaseVersionShape =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export class CinderPackageVersionError extends Error {
  override name = 'CinderPackageVersionError';
}

/** `source` with its `VERSION` literal replaced by `version`; refuses any other shape. */
export function stampPackageVersion(source: string, version: string): string {
  if (!releaseVersionShape.test(version)) {
    throw new CinderPackageVersionError(
      `${CINDER_PACKAGE_NAME}'s recorded version ${JSON.stringify(version)} is not a release version`,
    );
  }
  const match = versionExportShape.exec(source);
  if (!match) {
    throw new CinderPackageVersionError(
      "Cinder's package-version module is not shaped as `export const VERSION = '<version>';` after an optional comment",
    );
  }
  return `${match[1]}export const VERSION = '${version}';\n`;
}

/** A `Bun.build` plugin that stamps Cinder's last published version into its token runtime. */
export function cinderPackageVersionPlugin(): BunPlugin {
  return {
    name: 'cinder-package-version',
    setup(builder) {
      builder.onLoad({ filter: CINDER_PACKAGE_VERSION_MODULE }, async ({ path }) => {
        const version = await readLastPublishedVersion(CINDER_PACKAGE_NAME);
        if (version === undefined) {
          throw new CinderPackageVersionError(
            `scripts/mirror/package-map.json records no lastPublishedVersion for ${CINDER_PACKAGE_NAME}`,
          );
        }
        return {
          contents: stampPackageVersion(await Bun.file(path).text(), version),
          loader: 'ts',
        };
      });
    },
  };
}
