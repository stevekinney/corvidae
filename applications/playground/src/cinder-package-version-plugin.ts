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
 * documentation displays.
 *
 * The version names a published corpus, so it is stamped only when the bundled base is that
 * corpus: `cinder-published-bases.json` records each release's base digest, and a bundle whose
 * digest differs (token changes not yet published) keeps the `workspace` sentinel rather than
 * claim a release that does not contain its base. The digest itself is never rewritten.
 */

import type { BunPlugin } from 'bun';
import { dirname, join } from 'node:path';

import { PLAYGROUND_ROOT } from './playground-paths.ts';
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

/** Each published Cinder version's base digest, recorded from the registry tarballs. */
export const CINDER_PUBLISHED_BASES_PATH = join(
  PLAYGROUND_ROOT,
  'src',
  'cinder-published-bases.json',
);

/** The generated digest module beside the version module, in exactly its generated shape. */
const baseDigestExportShape = /export const BASE_SOURCE_DIGEST =\s*'(sha256:[0-9a-f]{64})';/;

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

/**
 * The version to stamp: `lastPublishedVersion` when the bundled base is the one that release
 * ships, and `undefined` (keep the sentinel) when the bundle carries unpublished token changes.
 * A release with no recorded digest is a refusal, since its corpus cannot be compared.
 */
export function publishedVersionForBase(
  bundledDigest: string,
  lastPublishedVersion: string,
  publishedBases: Readonly<Record<string, string>>,
): string | undefined {
  const publishedDigest = publishedBases[lastPublishedVersion];
  if (publishedDigest === undefined) {
    throw new CinderPackageVersionError(
      `cinder-published-bases.json records no base digest for ${CINDER_PACKAGE_NAME}@${lastPublishedVersion}, the lastPublishedVersion; record it from the registry tarball`,
    );
  }
  return publishedDigest === bundledDigest ? lastPublishedVersion : undefined;
}

/** The recorded base digest of each published Cinder version. */
export async function readPublishedBases(): Promise<Record<string, string>> {
  const record: unknown = await Bun.file(CINDER_PUBLISHED_BASES_PATH).json();
  const bases =
    typeof record === 'object' && record !== null && 'bases' in record ? record.bases : undefined;
  if (
    typeof bases !== 'object' ||
    bases === null ||
    Array.isArray(bases) ||
    !Object.values(bases).every((digest) => typeof digest === 'string')
  ) {
    throw new CinderPackageVersionError(
      'cinder-published-bases.json has no `bases` map of version to digest',
    );
  }
  return bases as Record<string, string>;
}

/** The digest the generated module beside `packageVersionPath` declares for the bundled base. */
export async function readBundledBaseDigest(packageVersionPath: string): Promise<string> {
  const source = await Bun.file(
    join(dirname(packageVersionPath), 'base-corpus.generated.ts'),
  ).text();
  const digest = baseDigestExportShape.exec(source)?.[1];
  if (digest === undefined) {
    throw new CinderPackageVersionError(
      "Cinder's base-corpus module does not declare `BASE_SOURCE_DIGEST` as a sha256 literal",
    );
  }
  return digest;
}

/** Where the plugin reads the release it may stamp; tests substitute their own. */
export type CinderPackageVersionSources = {
  lastPublishedVersion: () => Promise<string | undefined>;
  publishedBases: () => Promise<Record<string, string>>;
};

const recordedSources: CinderPackageVersionSources = {
  lastPublishedVersion: () => readLastPublishedVersion(CINDER_PACKAGE_NAME),
  publishedBases: readPublishedBases,
};

/**
 * A `Bun.build` plugin that stamps Cinder's last published version into its token runtime when
 * the bundled base is that release's, and otherwise leaves the `workspace` sentinel.
 */
export function cinderPackageVersionPlugin(
  sources: CinderPackageVersionSources = recordedSources,
): BunPlugin {
  return {
    name: 'cinder-package-version',
    setup(builder) {
      builder.onLoad({ filter: CINDER_PACKAGE_VERSION_MODULE }, async ({ path }) => {
        const lastPublishedVersion = await sources.lastPublishedVersion();
        if (lastPublishedVersion === undefined) {
          throw new CinderPackageVersionError(
            `scripts/mirror/package-map.json records no lastPublishedVersion for ${CINDER_PACKAGE_NAME}`,
          );
        }
        const version = publishedVersionForBase(
          await readBundledBaseDigest(path),
          lastPublishedVersion,
          await sources.publishedBases(),
        );
        const source = await Bun.file(path).text();
        return {
          contents: version === undefined ? source : stampPackageVersion(source, version),
          loader: 'ts',
        };
      });
    },
  };
}
