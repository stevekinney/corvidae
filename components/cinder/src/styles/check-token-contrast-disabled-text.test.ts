/**
 * COR-2303: disabled text stays legible. WCAG exempts an inactive control from the text floor, but
 * a disabled Button, Link or NavigationItem still has to be readable, so Cinder holds its own floor
 * of 4.5:1 for `--cinder-text-disabled` on every surface in every theme context. A disabled control
 * is painted with that colour directly (never an opacity fade, see `disabled-opacity.test.ts`), so
 * the measured ratio is the ratio on screen.
 */

import { describe, expect, it } from 'bun:test';

import {
  CINDER_BASE,
  CONTRAST_PAIRINGS,
  evaluateThemeProperties,
  measurePairing,
} from '../tokens/runtime/index.ts';

const DISABLED_TEXT_FLOOR = 4.5;

const evaluation = evaluateThemeProperties({
  revision: 1,
  resolver: CINDER_BASE.resolver,
  documents: CINDER_BASE.documents,
});
if (!evaluation.ok) throw new Error('The shipped Cinder base does not evaluate.');

const disabledText = CONTRAST_PAIRINGS.filter((pairing) => pairing.id.startsWith('disabled:text:'));

describe('disabled text contrast', () => {
  it('has a pairing on every surface', () => {
    expect(disabledText.map((pairing) => pairing.background).sort()).toEqual([
      '--cinder-surface',
      '--cinder-surface-canvas',
      '--cinder-surface-inset',
      '--cinder-surface-raised',
    ]);
  });

  for (const context of evaluation.contexts) {
    const properties = evaluation.properties[context.id]!;
    const theme = context.theme === 'dark' ? 'dark' : 'light';

    it(`${context.id}: --cinder-text-disabled is at least ${DISABLED_TEXT_FLOOR}:1 on every surface`, () => {
      for (const pairing of disabledText) {
        const measurement = measurePairing(pairing, properties, { theme });
        expect(measurement.status, pairing.id).toBe('measured');
        if (measurement.status !== 'measured') continue;
        expect(measurement.ratio, pairing.id).toBeGreaterThanOrEqual(DISABLED_TEXT_FLOOR);
      }
    });
  }
});
