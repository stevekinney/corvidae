/**
 * The ring on a script focus target draws for keyboard use only. The browser draws `:focus-visible`
 * on a script focus after a focused composer or before any input, so a tap or a cold load saw a
 * ring round the card a chat opens on (owner comment, 2026-11-17). happy-dom cannot evaluate
 * `:focus-visible`, so the foundation rule is read as text and the modality it depends on is
 * exercised directly.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { INPUT_MODALITY_ATTRIBUTE, trackInputModality } = await import('./input-modality.ts');

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

const modality = (): string | null =>
  document.documentElement.getAttribute(INPUT_MODALITY_ATTRIBUTE);

describe('trackInputModality', () => {
  test('names the attribute data-cinder-input-modality and says nothing until the first input', () => {
    expect(INPUT_MODALITY_ATTRIBUTE).toBe('data-cinder-input-modality');
    stop = trackInputModality(document);
    expect(modality()).toBeNull();
  });

  test('a key press says keyboard, and a modifier alone does not', () => {
    stop = trackInputModality(document);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    expect(modality()).toBeNull();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(modality()).toBe('keyboard');
  });

  test('a press or a touch says pointer, and the next key says keyboard again', () => {
    stop = trackInputModality(document);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    document.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    expect(modality()).toBe('pointer');
    document.dispatchEvent(new window.Event('touchstart', { bubbles: true }));
    expect(modality()).toBe('pointer');
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(modality()).toBe('keyboard');
  });

  test('stopping removes the attribute and the listeners', () => {
    const stopTracking = trackInputModality(document);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    stopTracking();
    expect(modality()).toBeNull();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(modality()).toBeNull();
  });
});

describe('the script focus target ring', () => {
  test('is drawn only while the keyboard was the last input', async () => {
    const css = await Bun.file(new URL('../styles/foundation.css', import.meta.url)).text();
    const flat = css.replace(/\s+/g, ' ');
    expect(flat).toContain(
      ":root:not([data-cinder-input-modality='keyboard']) [tabindex='-1']:focus-visible { outline: none; box-shadow: none; }",
    );
  });

  test('is documented with its one cost', async () => {
    const text = await Bun.file(
      new URL('../../documentation/focus-ring-policy.md', import.meta.url),
    ).text();
    expect(text).toContain('## Script focus targets');
    expect(text).toContain('data-cinder-input-modality');
    expect(text).toMatch(/typing an address/);
  });
});
