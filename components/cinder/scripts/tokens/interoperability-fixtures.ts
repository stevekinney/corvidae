/**
 * The offline interoperability fixture matrix (COR-486, R5): a manifest that pins each
 * fixture's source, version, SHA-256, license and expected import disposition, and the
 * integrity check that makes a changed fixture fail loudly. Reads files only; nothing is
 * fetched.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type InteroperabilityDisposition =
  'cinder-envelope' | 'dtcg-document' | 'unsupported-profile' | 'invalid';

export type InteroperabilityFixture = {
  id: string;
  /** Relative to the interoperability directory. */
  file: string;
  kind: 'positive-document' | 'synthetic' | 'negative';
  source: {
    url: string | null;
    repository: string | null;
    commit: string | null;
    path: string | null;
  };
  sha256: string;
  license: { spdx: string; attribution: string };
  expected: { disposition: InteroperabilityDisposition; reason: string; pathContains?: string };
};

export const INTEROPERABILITY_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'theme-builder',
  'interoperability',
);

export function loadInteroperabilityManifest(): InteroperabilityFixture[] {
  const manifest = JSON.parse(
    readFileSync(join(INTEROPERABILITY_DIRECTORY, 'manifest.json'), 'utf8'),
  ) as { fixtures: InteroperabilityFixture[] };
  return manifest.fixtures;
}

export const sha256Of = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

/** Throws when `bytes` are not the bytes the manifest pinned for the fixture. */
export function assertFixtureIntegrity(fixture: InteroperabilityFixture, bytes: Uint8Array): void {
  const actual = sha256Of(bytes);
  if (actual !== fixture.sha256) {
    throw new Error(
      `Fixture ${fixture.id} (${fixture.file}) hashes to ${actual}, but the manifest pins ${fixture.sha256}.`,
    );
  }
}

export function readFixtureBytes(fixture: InteroperabilityFixture): Uint8Array {
  return readFileSync(join(INTEROPERABILITY_DIRECTORY, fixture.file));
}

/** The fixture's text, after its integrity has been verified. */
export function readVerifiedFixture(fixture: InteroperabilityFixture): string {
  const bytes = readFixtureBytes(fixture);
  assertFixtureIntegrity(fixture, bytes);
  return Buffer.from(bytes).toString('utf8');
}
