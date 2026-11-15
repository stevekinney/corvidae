/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, cleanup, screen } = await import('@testing-library/svelte');
const { default: MessageSources } = await import('./message-sources.svelte');

afterEach(() => cleanup());

describe('MessageSources labels', () => {
  test('renders the host-provided count text as the control and its name', () => {
    render(MessageSources, {
      props: {
        sources: [{ label: 'Policy', url: 'https://example.com/policy' }],
        labels: {
          sources: 'Quellen',
          sourcesCount: (count: number) => `${count} Quelle`,
        },
      },
    });

    const control = screen.getByRole('button', { name: '1 Quelle' });
    expect(control.textContent?.replace(/\s+/g, ' ').trim()).toBe('1 Quelle');
    expect(control.getAttribute('aria-expanded')).toBe('false');
  });

  test('says "1 source" and "N sources" by default, with a chevron that is hidden from assistive technology', () => {
    const { container } = render(MessageSources, {
      props: { sources: [{ label: 'One' }, { label: 'Two' }, { label: 'Three' }] },
    });

    const control = screen.getByRole('button', { name: '3 sources' });
    expect(control.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.chat-message-sources-text')?.getAttribute('dir')).toBe('auto');
  });
});
