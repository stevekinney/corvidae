/**
 * The browserless half of the token consumer proof (COR-486): the saved envelope validates,
 * its six contexts evaluate, and the deployment CSS is produced through the public runtime
 * subpath. The Chromium half (`validate:consumer`) is not part of the default suite because
 * it needs Playwright's browser.
 */

import { describe, expect, spyOn, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

import {
  CONTEXTS,
  consumerArtifacts,
  runAsScript,
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

const checkModule = '../../fixtures/tokens-consumer/check.mjs';

describe('tokens-consumer failure modes', () => {
  const saved = () => JSON.parse(savedEnvelopeText());

  test('refuses an envelope written against a different Cinder base', () => {
    const envelope = saved();
    envelope.base.sourceDigest = `sha256:${'0'.repeat(64)}`;
    expect(() => consumerArtifacts(JSON.stringify(envelope))).toThrow(
      'The saved envelope was written against a different Cinder base.',
    );
  });

  test('refuses an envelope whose overrides do not validate, naming the diagnostics', () => {
    const envelope = saved();
    envelope.overrides.shared.radius.medium.$value = 'not a dimension';
    expect(() => consumerArtifacts(JSON.stringify(envelope))).toThrow(
      'The saved envelope is invalid:',
    );
  });

  test('run directly, it reports a one-line summary of what it checked', () => {
    const lines: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    try {
      expect(runAsScript(fileURLToPath(new URL(checkModule, import.meta.url)))).toBe(true);
      expect(runAsScript('/somewhere/else.mjs')).toBe(false);
    } finally {
      log.mockRestore();
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[tokens-consumer\] OK: 6 contexts, \d+ properties, \d+ bytes of CSS\.$/,
    );
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
