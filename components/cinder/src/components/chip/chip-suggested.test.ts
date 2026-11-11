/// <reference lib="dom" />
// COR-2326: a suggested chip reads in the accent text colour on a neutral chip, assistive
// technology hears "Suggested" first, and the chip gains no tint, border or second pill.
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

import { declarationsFor } from '../../test/css.ts';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: Chip } = await import('./chip.svelte');

afterEach(() => cleanup());

const chipCss = await Bun.file(new URL('./chip.css', import.meta.url)).text();

const SUGGESTED_LABEL_SELECTOR =
  ".cinder-chip[data-cinder-suggested]:where([data-cinder-variant='neutral']) .cinder-chip__label";

describe('Chip suggested', () => {
  test('a display chip is marked and says "Suggested" to assistive technology', () => {
    const { container } = render(Chip, { label: '@phone', suggested: true });
    const chip = requiredInstance(container.querySelector('.cinder-chip'), HTMLElement);
    expect(chip.hasAttribute('data-cinder-suggested')).toBe(true);
    expect(chip.hasAttribute('suggested')).toBe(false);
    const hidden = chip.querySelector('.cinder-chip__label .cinder-sr-only');
    expect(hidden?.textContent).toBe('Suggested: ');
    expect(chip.querySelector('.cinder-chip__label')?.textContent).toBe('Suggested: @phone');
  });

  test('a toggle chip carries the word in its button name', () => {
    const { container } = render(Chip, {
      mode: 'toggle',
      label: '@phone',
      pressed: false,
      suggested: true,
    });
    const button = requiredInstance(container.querySelector('button.cinder-chip'), HTMLElement);
    expect(button.hasAttribute('data-cinder-suggested')).toBe(true);
    expect(button.textContent?.trim()).toBe('Suggested: @phone');
  });

  test('a removable chip is marked too', () => {
    const { container } = render(Chip, {
      mode: 'removable',
      label: '@phone',
      suggested: true,
      onRemove: () => {},
    });
    const chip = requiredInstance(container.querySelector('.cinder-chip'), HTMLElement);
    expect(chip.hasAttribute('data-cinder-suggested')).toBe(true);
    expect(chip.querySelector('.cinder-chip__label .cinder-sr-only')?.textContent).toBe(
      'Suggested: ',
    );
  });

  test('a chip that is not suggested carries neither the marker nor the word', () => {
    const { container } = render(Chip, { label: '@phone' });
    const chip = requiredInstance(container.querySelector('.cinder-chip'), HTMLElement);
    expect(chip.hasAttribute('data-cinder-suggested')).toBe(false);
    expect(chip.querySelector('.cinder-sr-only')).toBeNull();
  });

  test('a neutral suggested chip reads in accent text and adds no tint or border', () => {
    const label = declarationsFor(chipCss, SUGGESTED_LABEL_SELECTOR);
    expect(label.get('color')).toBe('var(--cinder-accent-text)');
    expect([...label.keys()]).toEqual(['color']);
    // Disabled greys the label at equal specificity later in the file, so it still wins.
    const suggestedAt = chipCss.indexOf(SUGGESTED_LABEL_SELECTOR);
    const disabledAt = chipCss.indexOf('.cinder-chip[data-cinder-disabled] .cinder-chip__label');
    expect(suggestedAt).toBeGreaterThan(-1);
    expect(disabledAt).toBeGreaterThan(suggestedAt);
  });
});
