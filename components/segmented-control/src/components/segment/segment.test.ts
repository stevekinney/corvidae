/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, render, screen } = await import('@testing-library/svelte');
const { default: Fixture } = await import('../../test/fixtures/segmented-control-fixture.svelte');

afterEach(() => cleanup());

const options = [
  { value: 'source', label: 'Source' },
  { value: 'rendered', label: 'Rendered' },
  { value: 'diff', label: 'Diff', disabled: true },
];

function renderControl(value: string) {
  return render(Fixture, {
    props: { id: 'view', value, label: 'View', options },
  });
}

/**
 * Matches an accessible name while ignoring the space the DOM-based name computation puts before
 * an inline-block comma; a browser builds the same name without it.
 */
function named(expected: string): (name: string) => boolean {
  return (name) => name.replace(/\s+,/g, ',') === expected;
}

describe('Segment', () => {
  test('renders each segment as a button with role="radio" in single mode', () => {
    const { container } = renderControl('source');
    const segments = container.querySelectorAll('[role="radio"]');
    expect(segments).toHaveLength(3);
    expect(segments[0]?.tagName.toLowerCase()).toBe('button');
  });

  test('aria-checked reflects the selected value', () => {
    renderControl('source');
    expect(screen.getByRole('radio', { name: 'Source' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Rendered' }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  test('a disabled option surfaces aria-disabled', () => {
    renderControl('source');
    expect(screen.getByRole('radio', { name: 'Diff' }).getAttribute('aria-disabled')).toBe('true');
  });

  test('renders as an anchor with aria-current in navigation variant', () => {
    render(Fixture, {
      props: {
        id: 'source-filter',
        label: 'Source filter',
        variant: 'navigation',
        options: [
          { value: 'all', label: 'All', href: '/costs', current: true },
          { value: 'compute', label: 'Compute', href: '/costs?source=compute' },
        ],
      },
    });

    const current = screen.getByRole('link', { name: 'All' });
    expect(current.tagName.toLowerCase()).toBe('a');
    expect(current.getAttribute('href')).toBe('/costs');
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(current.getAttribute('data-cinder-current')).toBe('');
    expect(current.getAttribute('role')).toBeNull();
  });

  test('navigation anchors use href as their segment value when value is omitted', () => {
    render(Fixture, {
      props: {
        id: 'source-filter',
        label: 'Source filter',
        variant: 'navigation',
        options: [{ label: 'Compute', href: '/costs?source=compute' }],
      },
    });

    const compute = screen.getByRole('link', { name: 'Compute' });
    expect(compute.getAttribute('data-cinder-segment-value')).toBe('/costs?source=compute');
  });

  test('disabled navigation anchors strip href and block consumer clicks', async () => {
    const clicks: MouseEvent[] = [];
    render(Fixture, {
      props: {
        id: 'source-filter',
        label: 'Source filter',
        variant: 'navigation',
        options: [
          {
            value: 'all',
            label: 'All',
            href: '/costs',
            disabled: true,
            onclick: (event: MouseEvent) => clicks.push(event),
          },
        ],
      },
    });

    const disabled = screen.getByText('All').closest('a');
    expect(disabled).not.toBeNull();
    expect(disabled?.getAttribute('href')).toBeNull();
    expect(disabled?.getAttribute('aria-disabled')).toBe('true');

    disabled?.click();
    expect(clicks).toHaveLength(0);
  });

  test('a count is part of the accessible name and is drawn after the label', () => {
    const { container } = render(Fixture, {
      props: {
        id: 'status',
        label: 'Status',
        value: 'all',
        options: [
          { value: 'all', label: 'All', count: 19 },
          { value: 'waiting', label: 'Waiting on you', count: 2 },
          { value: 'running', label: 'Running', count: 0 },
          { value: 'plain', label: 'Plain' },
        ],
      },
    });

    expect(screen.getByRole('radio', { name: named('All, 19') }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByRole('radio', { name: named('Waiting on you, 2') })).toBeDefined();
    // Zero is a real count, so a segment with nothing in it still says so.
    expect(screen.getByRole('radio', { name: named('Running, 0') })).toBeDefined();
    expect(screen.getByRole('radio', { name: 'Plain' })).toBeDefined();
    expect(container.querySelectorAll('.cinder-segmented-control-option-count')).toHaveLength(3);
  });

  test('a pending count draws a dash and reads as loading', () => {
    const { container } = render(Fixture, {
      props: {
        id: 'status',
        label: 'Status',
        value: 'all',
        options: [
          { value: 'all', label: 'All', count: 'pending' },
          { value: 'waiting', label: 'Waiting on you', count: 'pending' },
        ],
      },
    });

    expect(screen.getByRole('radio', { name: named('All, loading') })).toBeDefined();
    const counts = container.querySelectorAll('[data-cinder-count-pending]');
    expect(counts).toHaveLength(2);
    expect(counts[0]?.textContent?.replace(/\s+/g, ' ').trim()).toBe(', loading–');
    expect(counts[0]?.querySelector('[aria-hidden="true"]')?.textContent).toBe('–');
  });

  test('a count reads the same on a navigation link', () => {
    render(Fixture, {
      props: {
        id: 'source-filter',
        label: 'Source filter',
        variant: 'navigation',
        options: [{ value: 'all', label: 'Done', href: '/runs?status=done', count: 12 }],
      },
    });

    expect(screen.getByRole('link', { name: named('Done, 12') })).toBeDefined();
  });
});
