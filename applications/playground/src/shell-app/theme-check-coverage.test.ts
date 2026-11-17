import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AUTHORING_CATALOGUE, CONTRAST_PAIRINGS } from '@lostgradient/cinder/tokens/runtime';

import {
  COVERAGE_CLASSES,
  buildCoverageLedger,
  classifyToken,
  coverageSummary,
} from './theme-check-coverage.ts';
import { CHECK_RULES } from './theme-check-rules.ts';
import { referencedSceneIds, sceneSitesFor } from './theme-check-scenes.ts';
import { themePreviewSceneById } from './theme-preview-scenes.ts';

const registry = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      '..',
      '..',
      '..',
      '..',
      'components',
      'cinder',
      'src',
      'tokens',
      'registry.generated.json',
    ),
    'utf8',
  ),
) as { entries: unknown[] };
const ledger = buildCoverageLedger();

describe('the token coverage ledger', () => {
  it('classifies every public registry token, whatever the count', () => {
    expect(registry.entries.length).toBeGreaterThan(0);
    expect(ledger).toHaveLength(registry.entries.length);
    expect(ledger).toHaveLength(AUTHORING_CATALOGUE.records.length);
    expect(new Set(ledger.map((entry) => entry.path)).size).toBe(ledger.length);
  });

  it('gives every token one known class and a stated reason', () => {
    for (const entry of ledger) {
      expect(COVERAGE_CLASSES).toContain(entry.coverage);
      expect(entry.reason.trim().length, entry.path).toBeGreaterThan(20);
    }
  });

  it('uses all four classes, so none is a placeholder', () => {
    const summary = coverageSummary(ledger);
    for (const coverage of COVERAGE_CLASSES) expect(summary[coverage], coverage).toBeGreaterThan(0);
  });

  it('fails loudly on a token whose profile has no coverage rule', () => {
    const [first] = AUTHORING_CATALOGUE.records;
    expect(() => classifyToken({ ...first!, profile: 'invented-profile' })).toThrow(
      'No coverage rule',
    );
  });

  it('marks every paired color statically checked and cites real pairings and rules', () => {
    const ruleIds = new Set(CHECK_RULES.map((rule) => rule.id));
    const pairingIds = new Set(CONTRAST_PAIRINGS.map((pairing) => pairing.id));
    const wcagForegrounds = new Set(
      CONTRAST_PAIRINGS.filter((pairing) => pairing.scope === 'wcag').map(
        (pairing) => pairing.foreground,
      ),
    );
    for (const entry of ledger) {
      for (const citation of entry.checkedBy) {
        expect(
          ruleIds.has(citation) || pairingIds.has(citation),
          `${entry.path}: ${citation}`,
        ).toBe(true);
      }
      if (wcagForegrounds.has(entry.cssProperty)) {
        expect(entry.coverage, entry.path).toBe('statically-checked');
      }
    }
  });

  it('keeps the scene mapping inside the scene manifest', () => {
    for (const sceneId of referencedSceneIds()) {
      expect(themePreviewSceneById(sceneId), sceneId).toBeDefined();
    }
    for (const pairing of CONTRAST_PAIRINGS) {
      for (const site of sceneSitesFor(pairing.group)) {
        expect(site.sceneId.length).toBeGreaterThan(0);
      }
    }
  });
});
