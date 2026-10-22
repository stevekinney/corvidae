import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const COMPONENTS_DIR = join(import.meta.dir, '..', 'components');
const STYLES_DIR = join(import.meta.dir, 'components');

// diff-viewer and review-editor moved to @lostgradient/editor (see
// documentation/decisions/package-boundaries.md); their audit entries moved with them
// and are no longer part of this package's source tree.
const auditedFiles = [
  join(COMPONENTS_DIR, 'badge', 'badge.css'),
  join(COMPONENTS_DIR, 'button', 'button.css'),
  join(COMPONENTS_DIR, 'chip', 'chip.css'),
  join(COMPONENTS_DIR, 'dropdown', 'dropdown.css'),
  join(STYLES_DIR, 'json-highlight.css'),
];

const forbiddenStatusMixPattern =
  /color-mix\((?:(?!;).|\r|\n)*?var\(\s*--cinder-(info|success|warning|danger)\s*(?:[,)\s])/m;

function declarationValue(source: string, token: string): string {
  const match = source.match(new RegExp(`${token}:\\s*([^;]+);`));
  if (!match?.[1]) throw new Error(`Missing ${token} declaration`);
  return match[1];
}

describe('status token usage', () => {
  test('audited files do not mix solid status tokens into soft surfaces', async () => {
    const failures: string[] = [];

    for (const file of auditedFiles) {
      const source = await readFile(file, 'utf-8');

      if (forbiddenStatusMixPattern.test(source)) {
        failures.push(file);
      }
    }

    expect(failures).toEqual([]);
  });

  test('chip variants use semantic status triples directly', async () => {
    const chipSource = await readFile(join(COMPONENTS_DIR, 'chip', 'chip.css'), 'utf-8');

    // Accent lives under its own domain rather than `status.*`: it is a brand
    // colour, not a status, and CIN-33 kept that distinction in the names.
    const soft = (variant: string) =>
      variant === 'accent' ? '--cinder-accent' : `--cinder-status-${variant}`;

    for (const status of ['neutral', 'accent', 'success', 'warning', 'danger', 'info']) {
      expect(chipSource).toContain(`var(${soft(status)}-background)`);
      expect(chipSource).toContain(`var(${soft(status)}-text)`);
      expect(chipSource).toContain(`var(${soft(status)}-border)`);
    }
  });

  // COR-1552: a Badge draws no visible outline. Its border is still there, so the box
  // keeps the same size, but each variant paints it in its own background. The
  // `--cinder-status-*-border` tokens are untouched, because Chip and the danger Button
  // read them and the stop button's hover paints one over its background.
  test("each Badge variant's border-color is its own background token", async () => {
    const badgeSource = await readFile(join(COMPONENTS_DIR, 'badge', 'badge.css'), 'utf-8');
    const soft = (variant: string) =>
      variant === 'accent' ? '--cinder-accent' : `--cinder-status-${variant}`;

    for (const variant of ['neutral', 'accent', 'success', 'warning', 'danger', 'info']) {
      const rule = badgeSource.match(
        new RegExp(`\\.cinder-badge\\[data-cinder-variant='${variant}'\\]\\s*\\{([^}]*)\\}`),
      );
      expect(rule?.[1], `${variant} rule`).toBeDefined();
      const body = rule?.[1] ?? '';
      expect(declarationValue(body, 'background')).toBe(`var(${soft(variant)}-background)`);
      expect(declarationValue(body, 'color')).toBe(`var(${soft(variant)}-text)`);
      expect(declarationValue(body, 'border-color')).toBe(`var(${soft(variant)}-background)`);
    }

    const critical = badgeSource.match(
      /\.cinder-badge\[data-cinder-severity='critical'\]\s*\{([^}]*)\}/,
    );
    const criticalBody = critical?.[1] ?? '';
    expect(declarationValue(criticalBody, 'border-color')).toBe(
      declarationValue(criticalBody, 'background'),
    );
    expect(badgeSource).not.toMatch(/-border\)/);
  });

  test('derived status tiers retain the polarity-aware relative-color formula', async () => {
    const tokens = await readFile(join(import.meta.dir, 'tokens-base.css'), 'utf-8');
    for (const status of ['info', 'success', 'warning', 'danger']) {
      const muted = declarationValue(tokens, `--cinder-status-${status}-muted`);
      const subtle = declarationValue(tokens, `--cinder-status-${status}-subtle`);
      expect(muted).toContain(`var(--cinder-status-${status}-solid)`);
      expect(muted).toContain('var(--cinder-surface)');
      expect(muted).toContain('36%');
      expect(subtle).toContain(`var(--cinder-status-${status}-solid)`);
      expect(subtle).toContain('var(--cinder-text-default)');
      expect(subtle).toContain('36%');
    }
  });
});
