/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, cleanup, screen } = await import('@testing-library/svelte');
const { default: MessageSources } = await import('./message-sources.svelte');

afterEach(() => cleanup());

describe('MessageSources labels', () => {
  test('renders host-provided source labels', () => {
    render(MessageSources, {
      props: {
        sources: [{ label: 'Policy', url: 'https://example.com/policy' }],
        presentation: 'list',
        listId: 'sources',
        labels: {
          sources: 'Quellen',
          sourcesCount: (count: number) => `Quellen (${count})`,
          openSource: () => 'Quelle öffnen',
        },
      },
    });

    expect(screen.getByRole('button', { name: 'Quellen (1)' })).toBeTruthy();
  });
});
