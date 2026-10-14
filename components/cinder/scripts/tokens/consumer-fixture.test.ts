/**
 * The browserless half of the token consumer proof (COR-486): the saved envelope validates,
 * its six contexts evaluate, and the deployment CSS is produced through the public runtime
 * subpath. The Chromium half (`validate:consumer`) is not part of the default suite because
 * it needs Playwright's browser.
 */

import { describe, expect, test } from 'bun:test';

import {
  CONTEXTS,
  runConsumerChecks,
  savedEnvelopeText,
} from '../../fixtures/tokens-consumer/check.mjs';
import { equalWithinTolerance } from '../../fixtures/tokens-consumer/tolerance.ts';

describe('tokens-consumer fixture', () => {
  test('the consumer checks pass for a saved envelope', () => {
    const { maps, css } = runConsumerChecks();
    expect(Object.keys(maps)).toEqual(CONTEXTS);
    expect(css).toContain('@layer cinder-theme {');
  });

  test('the saved envelope is a Cinder Theme v1 file with its base and the inherited strokeStyle source', () => {
    const saved = JSON.parse(savedEnvelopeText());
    expect(saved.format).toBe('com.lostgradient.cinder.theme');
    expect(saved.base.sourceDigest).toMatch(/^sha256:/);
    expect(saved.overrides.shared.stroke.$type).toBe('strokeStyle');
  });
});

describe('computed-style tolerance', () => {
  test('exact after whitespace normalization, numbers within 1e-6, otherwise unequal', () => {
    expect(equalWithinTolerance('color-mix(\n in oklch,  a )', 'color-mix(in oklch, a)')).toBe(
      true,
    );
    expect(equalWithinTolerance('oklch(50% 0.2000000004 270)', 'oklch(50% 0.2 270)')).toBe(true);
    expect(equalWithinTolerance('oklch(50% 0.21 270)', 'oklch(50% 0.2 270)')).toBe(false);
    expect(equalWithinTolerance('5px', '5rem')).toBe(false);
  });
});
