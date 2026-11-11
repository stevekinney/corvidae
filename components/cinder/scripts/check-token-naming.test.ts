import { describe, expect, test } from 'bun:test';

import { findNamingViolations } from './check-token-naming.ts';

describe('findNamingViolations', () => {
  test('accepts the shapes the corpus uses', () => {
    expect(
      findNamingViolations([
        'surface.base',
        'status.danger.solid',
        'status.danger.solid.hover',
        'button.padding.x.xs',
        'space.0-5',
      ]),
    ).toEqual([]);
  });

  // The failure the rename existed to fix: a bare domain carries no role, so
  // `danger` alone cannot be read without knowing which of its several
  // meanings — fill, text, border — was intended.
  test('rejects a bare domain with no role', () => {
    const violations = findNamingViolations(['danger']);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toMatch(/bare domain/);
  });

  // A group's `$root` token resolves to the group's own path, so `border.$root`
  // is `border` in the registry. It is the default among the roles beside it,
  // not a domain standing alone.
  test("accepts a group's $root token, which carries the group's own path", () => {
    expect(
      findNamingViolations([
        { path: 'border', cssProperty: '--cinder-border' },
        { path: 'border.muted', cssProperty: '--cinder-border-muted' },
      ]),
    ).toEqual([]);
  });

  test('still rejects a bare domain that is not a $root, beside an unrelated group', () => {
    const violations = findNamingViolations(['danger', 'border', 'border.muted', 'dangerous.text']);
    expect(violations).toEqual([{ path: 'danger', reason: expect.stringMatching(/bare domain/) }]);
  });

  test('holds a $root to every other rule', () => {
    const violations = findNamingViolations([
      { path: 'color', cssProperty: '--cinder-color' },
      { path: 'color.muted', cssProperty: '--cinder-color-muted' },
    ]);
    expect(violations.map((violation) => violation.path)).toContain('color');
  });

  test('rejects the color.* top-level namespace', () => {
    const violations = findNamingViolations(['color.danger.background']);
    expect(violations.map((violation) => violation.reason)).toContainEqual(
      expect.stringMatching(/classifies by type rather than intent/),
    );
  });

  test('rejects the CSS-derived abbreviations', () => {
    expect(findNamingViolations(['status.danger.bg'])).toHaveLength(1);
    expect(findNamingViolations(['status.danger.fg'])).toHaveLength(1);
  });

  // `text` is banned by the ticket's parenthetical but used by three of its own
  // examples. The examples win, so a rule banning it would reject the corpus
  // this ticket produced.
  test('does NOT reject `text`, which the naming examples themselves use', () => {
    expect(findNamingViolations(['text.default', 'status.danger.text'])).toEqual([]);
  });

  test('rejects a non-kebab-case segment', () => {
    expect(findNamingViolations(['status.danger.onSolid'])).toHaveLength(1);
    expect(findNamingViolations(['status.danger.on_solid'])).toHaveLength(1);
  });

  // Depth is deliberately uncapped: `status.<name>` is a compound domain, and
  // the corpus already carries four-segment component paths.
  test('does not cap depth', () => {
    expect(findNamingViolations(['accent.solid.active.on-fill'])).toEqual([]);
  });

  // A document-level `$root` token resolves to the empty path and has no name.
  test('ignores the empty path', () => {
    expect(findNamingViolations([''])).toEqual([]);
  });

  test('reports every violation on one path, not just the first', () => {
    const violations = findNamingViolations(['color.BG']);
    expect(violations.length).toBeGreaterThan(1);
  });
});
