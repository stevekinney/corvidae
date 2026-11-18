import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LINUX_BASELINE_DIRECTORY,
  PROVENANCE_FILE_NAME,
  REPOSITORY_ROOT,
  committedProvenanceProblems,
  createBaselineProvenance,
  dockerImageTagForPlaywrightVersion,
  mergeScopedProvenance,
  parseBaselineProvenance,
  playwrightBaseImage,
  readLockedPlaywrightVersion,
  readOsCodename,
  readPinnedBunVersion,
  readRepositoryPins,
  writeBaselineProvenance,
} from './baseline-provenance.ts';

const INPUT = {
  renderedSourceSha: 'abc123',
  playwrightVersion: '1.63.0',
  osCodename: 'jammy',
  architecture: 'arm64',
  dockerImageTag: dockerImageTagForPlaywrightVersion('1.63.0'),
  suiteExitCode: 1,
};

describe('baseline provenance', () => {
  it('creates deterministic provenance for a scoped baseline set', () => {
    const provenance = createBaselineProvenance({ ...INPUT, componentScope: 'button,button' });
    expect(provenance).toEqual({
      schemaVersion: 2,
      componentScope: ['button'],
      renderedSourceSha: 'abc123',
      playwrightVersion: '1.63.0',
      osCodename: 'jammy',
      architecture: 'arm64',
      dockerImageTag: 'corvidae-browser-fixtures:1.63.0-jammy-arm64',
      suiteExitCode: 1,
    });
    expect(JSON.stringify(provenance)).not.toContain('timestamp');
  });

  it('requires an explicit component scope', () => {
    expect(() => createBaselineProvenance({ ...INPUT, componentScope: '' })).toThrow(
      /explicit component scope/,
    );
  });

  it('serializes full-matrix provenance with an explicit all scope', () => {
    expect(createBaselineProvenance({ ...INPUT, componentScope: 'all' }).componentScope).toBe(
      'all',
    );
  });

  it('reads the Ubuntu codename from os-release', () => {
    const directory = mkdtempSync(join(tmpdir(), 'baseline-provenance-'));
    const path = join(directory, 'os-release');
    writeFileSync(path, 'NAME="Ubuntu"\nVERSION_CODENAME=jammy\n');
    expect(readOsCodename(path)).toBe('jammy');
    expect(readOsCodename(join(directory, 'missing'))).toBeUndefined();
  });

  it('writes stable JSON that parses back to the same record', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'baseline-provenance-'));
    const path = join(directory, 'linux', 'provenance.json');
    const provenance = createBaselineProvenance({ ...INPUT, componentScope: 'all' });
    await writeBaselineProvenance(path, provenance);
    const raw = readFileSync(path, 'utf8');
    expect(raw.endsWith('}\n')).toBe(true);
    expect(raw).not.toContain('timestamp');
    expect(parseBaselineProvenance(raw)).toEqual(provenance);
  });

  it('rejects provenance with a missing field or another schema version', () => {
    expect(() => parseBaselineProvenance('{"schemaVersion":2}')).toThrow(/renderedSourceSha/);
    const withoutExitCode: Record<string, unknown> = {
      ...createBaselineProvenance({ ...INPUT, componentScope: 'all' }),
    };
    delete withoutExitCode['suiteExitCode'];
    expect(() => parseBaselineProvenance(JSON.stringify(withoutExitCode))).toThrow(/suiteExitCode/);
    const wrongSchema = JSON.stringify({
      ...createBaselineProvenance({ ...INPUT, componentScope: 'all' }),
      schemaVersion: 1,
    });
    expect(() => parseBaselineProvenance(wrongSchema)).toThrow(/schemaVersion/);
  });
});

describe('repository pins', () => {
  it('reads the resolved @playwright/test version from bun.lock text', () => {
    const lockfile =
      '    "@playwright/test": ["@playwright/test@1.63.0", "", { "dependencies": { "playwright": "1.63.0" } }],\n';
    expect(readLockedPlaywrightVersion(lockfile)).toBe('1.63.0');
    expect(() => readLockedPlaywrightVersion('{}')).toThrow(/@playwright\/test/);
  });

  it('reads an exact Bun pin and rejects a range or a missing field', () => {
    expect(readPinnedBunVersion('{"packageManager":"bun@1.4.4"}')).toBe('1.4.4');
    expect(() => readPinnedBunVersion('{"packageManager":"bun@^1.4.4"}')).toThrow(/exact/);
    expect(() => readPinnedBunVersion('{}')).toThrow(/exact/);
  });

  it('derives the image tag and base image from the repository pins', () => {
    const { playwrightVersion, bunVersion } = readRepositoryPins();
    expect(playwrightVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(bunVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dockerImageTagForPlaywrightVersion(playwrightVersion)).toBe(
      `corvidae-browser-fixtures:${playwrightVersion}-jammy-arm64`,
    );
    expect(playwrightBaseImage(playwrightVersion)).toBe(
      `mcr.microsoft.com/playwright:v${playwrightVersion}-jammy`,
    );
  });
});

describe('scoped component renders (COR-1574)', () => {
  const full = createBaselineProvenance({
    ...INPUT,
    renderedSourceSha: 'f'.repeat(40),
    componentScope: 'all',
  });
  const scoped = createBaselineProvenance({
    ...INPUT,
    renderedSourceSha: 'b'.repeat(40),
    componentScope: 'chat-conversation-list,button',
  });

  it('keeps the full-run record and adds a render for each scoped component', () => {
    const merged = mergeScopedProvenance(full, scoped);
    expect(merged).toEqual({
      ...full,
      componentRenders: {
        button: { renderedSourceSha: 'b'.repeat(40), suiteExitCode: 1 },
        'chat-conversation-list': { renderedSourceSha: 'b'.repeat(40), suiteExitCode: 1 },
      },
    });
    expect(parseBaselineProvenance(JSON.stringify(merged))).toEqual(merged);
    expect(committedProvenanceProblems(merged, '1.63.0')).toEqual([]);
  });

  it('replaces an earlier render of the same component and keeps the others', () => {
    const later = createBaselineProvenance({
      ...INPUT,
      renderedSourceSha: 'c'.repeat(40),
      suiteExitCode: 0,
      componentScope: 'button',
    });
    expect(
      mergeScopedProvenance(mergeScopedProvenance(full, scoped), later).componentRenders,
    ).toEqual({
      button: { renderedSourceSha: 'c'.repeat(40), suiteExitCode: 0 },
      'chat-conversation-list': { renderedSourceSha: 'b'.repeat(40), suiteExitCode: 1 },
    });
  });

  it('refuses a scoped render under another renderer, or onto a record that is not a full run', () => {
    expect(() => mergeScopedProvenance(full, { ...scoped, playwrightVersion: '1.64.0' })).toThrow(
      /playwrightVersion/,
    );
    expect(() => mergeScopedProvenance(scoped, scoped)).toThrow(/not a full one/);
    expect(() => mergeScopedProvenance(full, full)).toThrow(/replaces provenance.json/);
  });

  it('rejects a malformed component render', () => {
    expect(() =>
      parseBaselineProvenance(JSON.stringify({ ...full, componentRenders: { button: {} } })),
    ).toThrow(/componentRenders.button/);
    expect(() =>
      parseBaselineProvenance(JSON.stringify({ ...full, componentRenders: [] })),
    ).toThrow(/componentRenders/);
  });

  it('names every way a record differs from the authoritative renderer', () => {
    expect(
      committedProvenanceProblems(
        {
          ...scoped,
          architecture: 'x64',
          componentRenders: { button: { renderedSourceSha: 'HEAD', suiteExitCode: 3 } },
        },
        '1.63.0',
      ),
    ).toEqual([
      'architecture is "x64", expected "arm64"',
      'componentScope is ["button","chat-conversation-list"], expected "all"',
      'component button renderedSourceSha is not a commit: HEAD',
      'component button suiteExitCode is 3, expected 0 or 1',
    ]);
  });
});

describe('committed provenance', () => {
  // Lands with the refreshed baselines (COR-1512). The full-run record is written only by
  // update-snapshots.ts inside the renderer, and a scoped refresh only adds component renders
  // to it (COR-1574), so it must agree with the lockfile pin and the arm64 jammy renderer the
  // authenticity guard enforces.
  it('records the renderer the lockfile and the authenticity guard require', () => {
    const provenance = parseBaselineProvenance(
      readFileSync(join(REPOSITORY_ROOT, LINUX_BASELINE_DIRECTORY, PROVENANCE_FILE_NAME), 'utf8'),
    );
    expect(committedProvenanceProblems(provenance, readRepositoryPins().playwrightVersion)).toEqual(
      [],
    );
  });
});
