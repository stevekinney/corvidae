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

  test('the rows sit in one tinted group', () => {
    expect(css).toMatch(
      /\[data-cinder-variant='fields'\]\s*\{[^}]*background: var\(--cinder-surface-inset\)/s,
    );
    expect(css).toMatch(
      /\[data-cinder-variant='fields'\]\s*\{[^}]*border-radius: var\(--cinder-radius-surface\)/s,
    );
  });

  test('each row is at least 44px tall with a rule inset to the text, and the last has none', () => {
    expect(css).toMatch(
      /\[data-cinder-variant='fields'\] \.cinder-description-list__row\s*\{[^}]*min-block-size: 2\.75rem/s,
    );
    expect(css).toMatch(
      /\[data-cinder-variant='fields'\]\s*\{[^}]*padding-inline-start: var\(--cinder-space-4\)/s,
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
