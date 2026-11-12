/**
 * The not-found page (design rows 12x and 12y): Cinder's not-found empty state with a title that
 * names the missing thing, the shared sentence, two secondary buttons and no primary one, and the
 * breadcrumb "Runs › Not found" in words.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { router } from '../lib/router.svelte.ts';
import { NOT_FOUND_COPY } from './copy/views.ts';
import Harness from './not-found-state.test-harness.svelte';

afterEach(cleanup);

/** Gives happy-dom's `about:blank` window a real origin, so `pushState` takes effect, at `path`. */
function landAt(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

describe('the not-found page', () => {
  test('names the missing thing, says why it may be gone, and has a neutral disc with a search glyph', () => {
    landAt('/runs/missing-run');
    const { container, getByRole } = render(Harness, {
      props: { title: 'This run doesn’t exist', view: 'runs' },
    });

    expect(getByRole('heading', { level: 1 }).textContent).toBe('This run doesn’t exist');
    expect(container.textContent).toContain(
      'It may have been deleted. The address might also be mistyped.',
    );
    const root = container.querySelector('.cinder-empty-state');
    expect(root?.getAttribute('data-cinder-kind')).toBe('not-found');
    const disc = root?.querySelector('.cinder-empty-state-icon');
    expect(disc?.getAttribute('aria-hidden')).toBe('true');
    expect(disc?.querySelector('svg')).not.toBeNull();
  });

  test('has two secondary buttons, Back to Runs and Search everything, and no primary one', () => {
    landAt('/runs/missing-run');
    const { container, getByRole } = render(Harness, {
      props: { title: 'This run doesn’t exist', view: 'runs' },
    });

    const buttons = [...container.querySelectorAll('.cinder-empty-state-action > *')];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Back to Runs',
      'Search everything',
    ]);
    for (const button of buttons) {
      expect(button.getAttribute('data-cinder-variant')).toBe('secondary');
    }
    expect(container.querySelector('[data-cinder-variant="primary"]')).toBeNull();
    expect(getByRole('link', { name: 'Back to Runs' }).getAttribute('href')).toBe('/runs');
  });

  test('Back to Runs opens the list in place', async () => {
    landAt('/runs/missing-run');
    const { getByRole } = render(Harness, {
      props: { title: 'This run doesn’t exist', view: 'runs' },
    });

    await fireEvent.click(getByRole('link', { name: 'Back to Runs' }));

    await waitFor(() => expect(router.pathname).toBe('/runs'));
  });

  test('Search everything asks the shell to open the palette', async () => {
    landAt('/runs/missing-run');
    let opened = 0;
    const { getByRole } = render(Harness, {
      props: {
        title: 'This run doesn’t exist',
        view: 'runs',
        onSearch: () => {
          opened += 1;
        },
      },
    });

    await fireEvent.click(getByRole('button', { name: NOT_FOUND_COPY.search }));

    expect(opened).toBe(1);
  });

  test('without a shell, Search everything does nothing and the page still renders', async () => {
    landAt('/runs/missing-run');
    const { getByRole } = render(Harness, { props: { title: 'This run doesn’t exist' } });

    await fireEvent.click(getByRole('button', { name: NOT_FOUND_COPY.search }));

    expect(getByRole('link', { name: 'Back to Home' }).getAttribute('href')).toBe('/');
  });

  test('puts “Not found” in the breadcrumb in place of the missing thing’s name', async () => {
    landAt('/runs/missing-run');
    const { getByTestId } = render(Harness, {
      props: { title: 'This run doesn’t exist', view: 'runs' },
    });

    await waitFor(() => expect(getByTestId('trail').textContent).toBe('Runs › Not found'));
  });

  test('leaves out Search everything for a page whose only way out is back to its list (a workflow’s page, row 63h)', () => {
    landAt('/workflows/gone');
    const { container, queryByRole } = render(Harness, {
      props: { title: 'Workflow not found', view: 'workflows', search: false },
    });

    const buttons = [...container.querySelectorAll('.cinder-empty-state-action > *')];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Back to Workflows']);
    expect(queryByRole('button', { name: NOT_FOUND_COPY.search })).toBeNull();
  });

  describe('a page whose missing thing can be started again (the chat page, row 19u)', () => {
    const create = { label: 'New chat', href: '/chats/new' };
    const back = { label: 'Back to chats', href: '/chats' };
    const props = { title: 'This chat doesn’t exist', view: 'chat' as const, create, back };

    test('offers a primary New chat and a secondary way back in the view’s words, and no search button', () => {
      landAt('/chats/gone');
      const { container, getByRole, queryByRole } = render(Harness, { props });

      const buttons = [...container.querySelectorAll('.cinder-empty-state-action > *')];
      expect(buttons.map((button) => button.textContent?.trim())).toEqual([
        'New chat',
        'Back to chats',
      ]);
      expect(buttons.map((button) => button.getAttribute('data-cinder-variant'))).toEqual([
        'primary',
        'secondary',
      ]);
      expect(getByRole('link', { name: 'New chat' }).getAttribute('href')).toBe('/chats/new');
      expect(getByRole('link', { name: 'Back to chats' }).getAttribute('href')).toBe('/chats');
      expect(queryByRole('button', { name: NOT_FOUND_COPY.search })).toBeNull();
    });

    test('draws an accent disc with an inbox rather than the neutral search glyph', () => {
      landAt('/chats/gone');
      const { container } = render(Harness, { props });

      const root = container.querySelector('.cinder-empty-state');
      expect(root?.getAttribute('data-cinder-kind')).toBe('first-use');
      expect(root?.querySelector('.cinder-empty-state-icon svg.lucide-inbox')).not.toBeNull();
    });

    test('New chat and Back to chats open their pages in place', async () => {
      landAt('/chats/gone');
      const { getByRole } = render(Harness, { props });

      await fireEvent.click(getByRole('link', { name: 'Back to chats' }));
      await waitFor(() => expect(router.pathname).toBe('/chats'));

      landAt('/chats/gone');
      await fireEvent.click(getByRole('link', { name: 'New chat' }));
      await waitFor(() => expect(router.pathname).toBe('/chats/new'));
    });

    test('keeps “Not found” in the breadcrumb, never the identifier', async () => {
      landAt('/chats/gone');
      const { getByTestId } = render(Harness, { props });

      await waitFor(() => expect(getByTestId('trail').textContent).toBe('Chat › Not found'));
    });
  });
});
