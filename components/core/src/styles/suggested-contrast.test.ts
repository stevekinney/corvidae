// COR-2326: the suggested label is accent text on every surface it sits on: a card's surface, a
// grouped-list or inspector row on the raised surface, the inset, and a neutral chip's fill. Each
// pairing is gated at AA text contrast in both themes and every context.
import { describe, expect, it } from 'bun:test';

import {
  CINDER_BASE,
  CONTRAST_PAIRINGS,
  evaluateThemeProperties,
  measurePairing,
  requiredContrast,
} from '../tokens/runtime/index.ts';

const evaluation = evaluateThemeProperties({
  revision: 1,
  resolver: CINDER_BASE.resolver,
  documents: CINDER_BASE.documents,
});
if (!evaluation.ok) throw new Error('The shipped Cinder base does not evaluate.');
const contexts = evaluation.contexts;

const SUGGESTED_BACKGROUNDS = [
  '--cinder-surface',
  '--cinder-surface-raised',
  '--cinder-surface-inset',
  '--cinder-status-neutral-background',
] as const;

describe('suggested label contrast', () => {
  for (const background of SUGGESTED_BACKGROUNDS) {
    const pairing = CONTRAST_PAIRINGS.find(
      (entry) => entry.foreground === '--cinder-accent-text' && entry.background === background,
    );

    it(`accent text on ${background} is a WCAG pairing`, () => {
      expect(pairing?.scope).toBe('wcag');
    });

    for (const context of contexts) {
      const theme = context.theme === 'dark' ? 'dark' : 'light';
      it(`${context.id}: accent text on ${background} meets AA text contrast`, () => {
        if (pairing === undefined) throw new Error(`No pairing for accent text on ${background}.`);
        const required = requiredContrast(pairing.classification);
        expect(required).not.toBeNull();
        const measurement = measurePairing(pairing, evaluation.properties[context.id]!, { theme });
        expect(measurement.status).toBe('measured');
        if (measurement.status !== 'measured' || required === null) return;
        expect(measurement.ratio).toBeGreaterThanOrEqual(required);
      });
    }
  }
});
