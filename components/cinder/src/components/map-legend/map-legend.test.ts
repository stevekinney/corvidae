/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: MapLegend } = await import('./map-legend.svelte');

const items = [
  { state: 'live', label: 'Now' },
  { state: 'idle', label: 'Later' },
] as const;

describe('MapLegend', () => {
  test('renders one entry per state with its meaning', () => {
    const { container } = render(MapLegend, { items: [...items] });
    const entries = [...container.querySelectorAll('li')];
    expect(entries.map((entry) => entry.textContent?.trim())).toEqual(['Now', 'Later']);
    expect(entries[0]?.querySelector('[data-state="live"]')).not.toBeNull();
  });

  test('always renders the OpenStreetMap and ODbL credit by default', () => {
    const { container } = render(MapLegend, { items: [] });
    const attribution = container.querySelector('.cinder-map-legend__attribution');
    expect(attribution?.textContent).toContain('OpenStreetMap');
    expect(attribution?.textContent).toContain('ODbL');
    expect(attribution?.querySelectorAll('a')).toHaveLength(2);
  });

  test('names the legend and merges a custom class', () => {
    const { container } = render(MapLegend, { items: [], label: 'Map key', class: 'extra' });
    const legend = container.querySelector('section');
    expect(legend?.getAttribute('aria-label')).toBe('Map key');
    expect(legend?.classList.contains('cinder-map-legend')).toBe(true);
    expect(legend?.classList.contains('extra')).toBe(true);
  });
});
