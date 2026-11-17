/**
 * The ring round an approval the page focuses by script (the chat's waiting card, a review's row)
 * shows for keyboard use only. The browser draws `:focus-visible` on a script focus after a focused
 * composer or before any input, so a tap or a cold load saw a blue ring round the card on arrival
 * (owner comment, 2026-11-17). happy-dom cannot evaluate `:focus-visible`, so the rule is read as
 * text and the modality it depends on is exercised directly.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { trackInputModality } from './input-modality.ts';

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

const modality = (): string | undefined => document.documentElement.dataset['inputModality'];

describe('trackInputModality', () => {
  test('says nothing until the first input', () => {
    stop = trackInputModality(document);
    expect(modality()).toBeUndefined();
  });

  test('a key press says keyboard, and a modifier alone does not', () => {
    stop = trackInputModality(document);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    expect(modality()).toBeUndefined();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(modality()).toBe('keyboard');
  });

  test('a press or a touch says pointer, and the next key says keyboard again', () => {
    stop = trackInputModality(document);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    document.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    expect(modality()).toBe('pointer');
    document.dispatchEvent(new window.Event('touchstart', { bubbles: true }));
    expect(modality()).toBe('pointer');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(modality()).toBe('keyboard');
  });

  test('stopping removes the attribute and the listeners', () => {
    const stopTracking = trackInputModality(document);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    stopTracking();
    expect(modality()).toBeUndefined();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(modality()).toBeUndefined();
  });
});

describe('the approval focus ring', () => {
  test('is drawn only while the keyboard was the last input', async () => {
    const css = await Bun.file(new URL('../styles/decisions.css', import.meta.url)).text();
    const start = css.indexOf('[data-approval-decision]:focus-visible');
    expect(start, 'a rule for a script-focused approval').toBeGreaterThanOrEqual(0);
    const rule = css.slice(css.lastIndexOf('\n\n', start), css.indexOf('}', start));
    expect(rule).toContain(":root:not([data-input-modality='keyboard'])");
    expect(rule).toMatch(/outline:\s*none/);
    expect(rule).toMatch(/box-shadow:\s*none/);
  });
});
