/**
 * The not-found page (design rows 12x and 12y): Cinder's not-found empty state with a title that
 * names the missing thing, the shared sentence, two secondary buttons and no primary one, and the
 * breadcrumb "Runs › Not found" in words.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { router } from '../lib/router.svelte.ts';
import { NOT_FOUND_COPY } from './copy.ts';
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
});
