/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: AttemptsIndicator } = await import('./attempts-indicator.svelte');

function segmentsOf(container: HTMLElement) {
  return [...container.querySelectorAll('.cinder-attempts-indicator__segment')];
}

function filledCount(container: HTMLElement) {
  return segmentsOf(container).filter((segment) => segment.hasAttribute('data-cinder-filled'))
    .length;
}

describe('AttemptsIndicator', () => {
  test('draws one segment per allowed attempt, filled for the attempts made', () => {
    const { container } = render(AttemptsIndicator, { made: 2, allowed: 5 });
    expect(segmentsOf(container)).toHaveLength(5);
    expect(filledCount(container)).toBe(2);
  });

  test.each([
    [5, 5],
    [1, 1],
    [0, 3],
  ])('%i of %i fills the made segments', (made, allowed) => {
    const { container } = render(AttemptsIndicator, { made, allowed });
    expect(segmentsOf(container)).toHaveLength(allowed);
    expect(filledCount(container)).toBe(made);
  });

  test('is an image named "2 of 5 attempts" and hides its segments', () => {
    const { container } = render(AttemptsIndicator, { made: 2, allowed: 5 });
    const root = container.querySelector('.cinder-attempts-indicator');
    expect(root?.getAttribute('role')).toBe('img');
    expect(root?.getAttribute('aria-label')).toBe('2 of 5 attempts');
    for (const segment of segmentsOf(container)) {
      expect(segment.getAttribute('aria-hidden')).toBe('true');
    }
  });

  test('is neutral and inline by default, and accepts accent and block', () => {
    const { container } = render(AttemptsIndicator, { made: 1, allowed: 2 });
    const root = container.querySelector('.cinder-attempts-indicator');
    expect(root?.getAttribute('data-cinder-tone')).toBe('neutral');
    expect(root?.getAttribute('data-cinder-layout')).toBe('inline');

    const accent = render(AttemptsIndicator, {
      made: 3,
      allowed: 8,
      tone: 'accent',
      layout: 'block',
      label: 'Attempt 3 of 8',
    });
    const accentRoot = accent.container.querySelector('.cinder-attempts-indicator');
    expect(accentRoot?.getAttribute('data-cinder-tone')).toBe('accent');
    expect(accentRoot?.getAttribute('data-cinder-layout')).toBe('block');
    expect(accentRoot?.getAttribute('aria-label')).toBe('Attempt 3 of 8');
    expect(segmentsOf(accent.container)).toHaveLength(8);
  });

  test('clamps made to allowed and reads pathological counts as whole numbers at or above zero', () => {
    const over = render(AttemptsIndicator, { made: 9, allowed: 4 });
    expect(filledCount(over.container)).toBe(4);
    expect(over.container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      '4 of 4 attempts',
    );

    const negative = render(AttemptsIndicator, { made: -3, allowed: 2.9 });
    expect(segmentsOf(negative.container)).toHaveLength(2);
    expect(filledCount(negative.container)).toBe(0);

    const notANumber = render(AttemptsIndicator, { made: Number.NaN, allowed: Number.NaN });
    expect(segmentsOf(notANumber.container)).toHaveLength(0);
  });

  test('caps the drawn segments at 100 and fills them in proportion', () => {
    const { container } = render(AttemptsIndicator, { made: 500_000, allowed: 1_000_000 });
    expect(segmentsOf(container)).toHaveLength(100);
    expect(filledCount(container)).toBe(50);
  });

  test('the stylesheet draws neutral by default with a forced-colors fallback', () => {
    const stylesheet = readFileSync(new URL('./attempts-indicator.css', import.meta.url), 'utf8');
    expect(stylesheet).toContain('--_cinder-attempts-indicator-fill: var(--cinder-border-control)');
    expect(stylesheet).toContain("[data-cinder-tone='accent']");
    expect(stylesheet).toContain('forced-colors: active');
    expect(stylesheet).toContain('Highlight');
  });
});
