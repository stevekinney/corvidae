/**
 * The page at `/` (design row 03l): its heading is Cinder's `visually-hidden` wrapper, so the page
 * shows no heading of its own, and a screen reader still finds "Home".
 */
import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import Home from './index.svelte';

describe('Home', () => {
  test('has one level-one heading, visually hidden, which says Home', () => {
    const { getByRole } = render(Home);
    const heading = getByRole('heading', { level: 1, name: 'Home' });
    expect(heading.classList.contains('cinder-sr-only')).toBe(true);
  });
});
