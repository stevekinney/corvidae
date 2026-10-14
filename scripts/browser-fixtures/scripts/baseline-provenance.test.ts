import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createBaselineProvenance,
  dockerImageTagForPlaywrightVersion,
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
    expect(readPinnedBunVersion('{"packageManager":"bun@1.4.2"}')).toBe('1.4.2');
    expect(() => readPinnedBunVersion('{"packageManager":"bun@^1.4.2"}')).toThrow(/exact/);
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
