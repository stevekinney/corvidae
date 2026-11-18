/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const css = readFileSync(new URL('./description-list.css', import.meta.url), 'utf8');

describe('DescriptionList record-details anatomy (fields variant)', () => {
  test('the term sits in a fixed 140px column and the value takes the rest', () => {
    expect(css).toMatch(
      /\[data-cinder-variant='fields'\]\s*\{[^}]*grid-template-columns: 8\.75rem minmax\(0, 1fr\)/s,
    );
  });

  test('the rows are flat by default and sit in one tinted group under framed', () => {
    const flat = /\[data-cinder-variant='fields'\]\s*\{([^}]*)\}/s.exec(css)?.[1] ?? '';
    expect(flat).not.toContain('background');
    expect(flat).not.toContain('border-radius');
    // The group's fill is the list's `::before`, so a container query on the list can switch it.
    expect(css).toMatch(
      /\[data-cinder-variant='fields'\]\[data-cinder-framed\]::before\s*\{[^}]*background: var\(--cinder-surface-inset\)/s,
    );
    expect(css).toMatch(
      /\[data-cinder-variant='fields'\]\[data-cinder-framed\]\s*\{[^}]*border-radius: var\(--cinder-radius-surface\)/s,
    );
  });

  test('each row is at least 44px tall with a rule inset to the text, and the last has none', () => {
    expect(css).toMatch(
      /\[data-cinder-variant='fields'\] \.cinder-description-list__row\s*\{[^}]*min-block-size: 2\.75rem/s,
    );
    expect(css).toMatch(
      /\[data-cinder-variant='fields'\]\[data-cinder-framed\]\s*\{[^}]*padding-inline-start: var\(--cinder-space-4\)/s,
    );
    // Flat, the rows start at the list's own edge: the inset belongs to the frame alone.
    expect(css).toMatch(
      /\[data-cinder-variant='fields'\] \.cinder-description-list__row\s*\{[^}]*padding-inline: 0 /s,
    );
    expect(css).toMatch(
      /\[data-cinder-variant='fields'\] \.cinder-description-list__row:last-child\s*\{[^}]*border-block-end-color: transparent/s,
    );
  });

  test('the term is muted and the value keeps the default text colour', () => {
    expect(css).toMatch(
      /\[data-cinder-variant='fields'\] dt\s*\{[^}]*color: var\(--cinder-text-muted\)/s,
    );
    expect(css).toMatch(
      /\[data-cinder-variant='fields'\] dd\s*\{[^}]*color: var\(--cinder-text-default\)/s,
    );
  });
});

describe('DescriptionList values', () => {
  test('a value breaks inside an unbroken word, so a long one never widens the list', () => {
    expect(css).toMatch(/\.cinder-description-list__definition\s*\{[^}]*overflow-wrap: anywhere/s);
  });
});
