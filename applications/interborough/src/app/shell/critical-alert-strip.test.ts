/**
 * Component tests for `<CriticalAlertStrip>`: the dismissible strip below the header. The one
 * critical item the bell holds is the host's own problem, an engine that does not answer.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { router } from '../../lib/router.svelte.ts';
import { memoryStore } from '../notification-store.test-support.ts';
import CriticalAlertStrip from './critical-alert-strip.svelte';

/** Gives happy-dom's `about:blank` window a real origin, so `pushState` takes effect, at `path`. */
function landAt(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

describe('CriticalAlertStrip', () => {
  test('renders nothing when there are no unread critical items', async () => {
    const store = memoryStore();
    const { container } = render(CriticalAlertStrip, { props: { store } });

    expect(container.querySelector('.weft-critical-strip')).toBeNull();
  });

  test('names an unreachable engine, and not one that is only stale', async () => {
    const store = memoryStore();
    store.reportEngineStatus('stale', 1);
    const stale = render(CriticalAlertStrip, { props: { store } });
    expect(stale.container.querySelector('.weft-critical-strip')).toBeNull();
    stale.unmount();

    store.reportEngineStatus('closed', 2);
    const { container } = render(CriticalAlertStrip, { props: { store } });

    expect(container.querySelectorAll('.weft-critical-strip__row')).toHaveLength(1);
    expect(container.textContent).toContain('Server unreachable');
  });

  test('dismissing a row calls dismissCritical and removes it from the strip', async () => {
    const store = memoryStore();
    store.reportEngineStatus('closed', 1);

    const { container, getByRole } = render(CriticalAlertStrip, { props: { store } });
    expect(container.querySelectorAll('.weft-critical-strip__row')).toHaveLength(1);

    await fireEvent.click(getByRole('button', { name: /Dismiss/ }));

    expect(container.querySelectorAll('.weft-critical-strip__row')).toHaveLength(0);
    expect(store.items[0]?.read).toBe(true);
  });

  test('following a row’s link dismisses it and routes to its target in place', async () => {
    landAt('/');
    const store = memoryStore();
    store.reportEngineStatus('closed', 1);

    const { container } = render(CriticalAlertStrip, { props: { store } });
    const link = container.querySelector('.weft-critical-strip__row a');
    if (link === null) throw new Error('Expected the row to render its link');
    const target = new URL(link.getAttribute('href') ?? '', 'http://localhost/');

    expect(await fireEvent.click(link)).toBe(false);
    expect(router.pathname).toBe(target.pathname);
    expect(store.items[0]?.read).toBe(true);
    expect(container.querySelectorAll('.weft-critical-strip__row')).toHaveLength(0);
  });
});
