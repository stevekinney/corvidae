import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import TimeParts from './time-parts.svelte';

afterEach(() => cleanup());

describe('a list row time on a phone', () => {
  test('keeps the day and the clock each whole, so the time breaks only after the comma', () => {
    const { container } = render(TimeParts, { props: { text: 'Yesterday, 6:00 PM' } });
    const parts = [...container.querySelectorAll('.ib-time-part')].map((part) => part.textContent);
    expect(parts).toEqual(['Yesterday,', '6:00 PM']);
    // The row still reads the whole time, one space between the parts.
    expect(container.textContent).toBe('Yesterday, 6:00 PM');
  });

  test('draws a time with no day as one whole part', () => {
    for (const text of ['6:00 PM', 'Oct 30']) {
      const { container } = render(TimeParts, { props: { text } });
      expect(
        [...container.querySelectorAll('.ib-time-part')].map((part) => part.textContent),
      ).toEqual([text]);
      cleanup();
    }
  });
});
