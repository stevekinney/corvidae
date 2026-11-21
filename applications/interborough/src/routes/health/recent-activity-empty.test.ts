/**
 * Recent activity with nothing in it is Cinder's one empty state alone (owner report,
 * 2026-11-19): no "Recent activity" heading and audit link above it saying the same thing, and the
 * section is named by its region instead.
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { HEALTH_ACTIVITY_COPY as copy } from './health-copy.ts';
import RecentActivity from './recent-activity.svelte';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('Recent activity with nothing in it', () => {
  test('is the empty state alone, with no heading or link above it', () => {
    const { container, getByRole, queryByRole } = render(RecentActivity, {
      props: { lines: [], total: 0 },
    });
    const state = container.querySelector('[data-testid="recent-activity-empty"]');
    expect(state?.classList.contains('cinder-empty-state')).toBe(true);
    expect(getByRole('heading', { level: 2 }).textContent?.trim()).toBe(copy.empty.title);
    expect(queryByRole('link')).toBeNull();
    expect(container.querySelector('section')?.getAttribute('aria-label')).toBe(copy.title);
  });

  test('keeps its heading and audit link once something has happened', () => {
    const { getByRole } = render(RecentActivity, {
      props: {
        lines: [{ id: 'one', at: 0, text: 'Server started', time: '9:00 AM' }],
        total: 1,
      },
    });
    expect(getByRole('heading', { level: 2 }).textContent).toContain(copy.title);
    expect(getByRole('link').textContent).toContain(copy.auditLink(1));
  });
});
