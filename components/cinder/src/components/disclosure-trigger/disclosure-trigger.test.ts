/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, fireEvent, cleanup } = await import('@testing-library/svelte');
const { createRawSnippet } = await import('svelte');
const { default: DisclosureTrigger } = await import('./disclosure-trigger.svelte');

const cssText = await Bun.file(new URL('./disclosure-trigger.css', import.meta.url)).text();

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const words = (text: string) => createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));

describe('DisclosureTrigger (board row X3)', () => {
  test('is a button that says whether its region is open and names it', async () => {
    const onclick = mock(() => undefined);
    const { container, rerender } = render(DisclosureTrigger, {
      props: { open: false, controls: 'details-1', onclick, children: words('Details') },
    });
    const button = container.querySelector('button')!;
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('details-1');
    expect(button.querySelector('.cinder-disclosure-trigger__label')?.textContent).toBe('Details');
    expect(
      button.querySelector('.cinder-disclosure-trigger__chevron')?.getAttribute('aria-hidden'),
    ).toBe('true');

    await fireEvent.click(button);
    expect(onclick).toHaveBeenCalledTimes(1);

    await rerender({ open: true, controls: 'details-1', onclick, children: words('Details') });
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  test('draws one look: a 14px muted chevron at the start that turns down when open, and medium words', () => {
    expect(cssText).toMatch(
      /\.cinder-disclosure-trigger__chevron \{[^}]*inline-size: 14px;[^}]*color: var\(--cinder-text-muted\);/,
    );
    expect(cssText).toMatch(
      /\.cinder-disclosure-trigger\[aria-expanded='true'\] \.cinder-disclosure-trigger__chevron \{\s*transform: rotate\(90deg\);/,
    );
    expect(cssText).toMatch(
      /\.cinder-disclosure-trigger \{[^}]*font-weight: var\(--cinder-font-medium\);/,
    );
  });

  test('lets its words take the rest of a widened row, so a time can sit at the line end', () => {
    // The trigger is a flex row and the label grows: a trigger sized to its words is unchanged,
    // and a step row that fills its line keeps its duration at the far edge (COR-2440).
    expect(cssText).toMatch(/\.cinder-disclosure-trigger \{[^}]*display: inline-flex;/);
    expect(cssText).toMatch(
      /\.cinder-disclosure-trigger__label \{[^}]*flex: 1 1 auto;[^}]*min-inline-size: 0;/,
    );
  });

  test('passes a class and other attributes through, and keeps type button', () => {
    const { container } = render(DisclosureTrigger, {
      props: {
        open: true,
        class: 'wide',
        'aria-label': 'Hide details',
        children: words('Details'),
      },
    });
    const button = container.querySelector('button')!;
    expect(button.classList.contains('cinder-disclosure-trigger')).toBe(true);
    expect(button.classList.contains('wide')).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('Hide details');
  });
});
