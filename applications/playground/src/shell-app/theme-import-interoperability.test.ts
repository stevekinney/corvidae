/**
 * The interoperability matrix through the real preflight (COR-486, R5). The fixtures and their
 * manifest live with Cinder's token tests; each fixture is checked against its pinned SHA-256
 * before it is used, so a changed fixture fails here as well. Nothing is fetched.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cinderThemeBase } from './theme-builder-base.ts';
import { createEnvelope } from './theme-envelope.ts';
import { preflightImport } from './theme-import-preflight.ts';
import { canApply } from './theme-import-types.ts';

const DIRECTORY = join(
  import.meta.dir,
  '../../../../components/cinder/scripts/tokens/fixtures/theme-builder/interoperability',
);

type Fixture = {
  id: string;
  file: string;
  sha256: string;
  expected: { disposition: string; reason: string; pathContains?: string };
};

const fixtures = (
  JSON.parse(readFileSync(join(DIRECTORY, 'manifest.json'), 'utf8')) as { fixtures: Fixture[] }
).fixtures;

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const current = createEnvelope('open', 'Open', cinderThemeBase());
const loaded = await Promise.all(
  fixtures.map(async (fixture) => {
    const bytes = readFileSync(join(DIRECTORY, fixture.file));
    return {
      fixture,
      hash: await sha256(bytes),
      result: await preflightImport(Buffer.from(bytes).toString('utf8'), fixture.file, current),
    };
  }),
);

describe('the interoperability matrix', () => {
  test('every fixture is the pinned bytes', () => {
    for (const { fixture, hash } of loaded) expect(hash).toBe(fixture.sha256);
  });

  test.each(loaded.map((entry) => [entry.fixture.id, entry] as const))(
    '%s has its expected disposition',
    (_id, { fixture, result }) => {
      expect(result.outcome).toBe(fixture.expected.disposition as typeof result.outcome);
      if (fixture.expected.pathContains !== undefined) {
        expect(result.findings.some((f) => f.path.includes(fixture.expected.pathContains!))).toBe(
          true,
        );
      }
    },
  );

  test('the Terrazzo positives import as Source tokens only, with no CSS binding', () => {
    for (const id of ['terrazzo-figma-sds-size', 'terrazzo-figma-sds-color']) {
      const entry = loaded.find((candidate) => candidate.fixture.id === id)!;
      expect(canApply(entry.result)).toBe(true);
      const facts = Object.fromEntries(entry.result.facts.map((f) => [f.label, f.value]));
      expect(facts['Known Cinder tokens']).toBe('0');
      expect(Number(facts['Source tokens (kept, no CSS)'])).toBeGreaterThan(10);
    }
  });

  test('foreign dialects are download-only and leave the draft candidate empty', () => {
    for (const id of [
      'synthetic-extra-axis-resolver',
      'synthetic-json5-like',
      'synthetic-acronis-like',
      'synthetic-spectrum-like',
    ]) {
      const entry = loaded.find((candidate) => candidate.fixture.id === id)!;
      expect(entry.result.candidate).toBeNull();
      expect(canApply(entry.result)).toBe(false);
      expect('text' in entry.result.source).toBe(true);
      expect(entry.result.findings).toEqual([]);
    }
  });

  test('the inherited strokeStyle source token imports with its metadata intact', () => {
    const entry = loaded.find((c) => c.fixture.id === 'synthetic-inherited-stroke-style')!;
    const candidate = entry.result.candidate;
    expect(candidate?.kind).toBe('overlay');
    const shared = candidate!.envelope.overrides.shared as Record<string, any>;
    expect(shared['stroke'].$type).toBe('strokeStyle');
    expect(shared['stroke'].dashed).toEqual({
      $value: 'dashed',
      $description: 'Inherits strokeStyle.',
    });
    expect(shared['$extensions']).toEqual({ 'com.example.editor': { untouched: true } });
  });
});
