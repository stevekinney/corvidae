/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: MapMarker } = await import('./map-marker.svelte');

describe('MapMarker', () => {
  test('renders a button that defaults to the idle state and shows its label', () => {
    const { container } = render(MapMarker, { label: '8 pm' });
    const button = container.querySelector('button');
    expect(button?.getAttribute('type')).toBe('button');
    expect(button?.getAttribute('data-state')).toBe('idle');
    expect(button?.querySelector('.cinder-map-marker__label')?.textContent).toBe('8 pm');
  });

  test('every state except a cluster draws an anchor', () => {
    for (const state of ['live', 'idle', 'selected'] as const) {
      const { container, unmount } = render(MapMarker, { label: 'x', state });
      expect(container.querySelector('.cinder-map-marker__anchor')).not.toBeNull();
      unmount();
    }
    const { container } = render(MapMarker, { label: '12', state: 'cluster' });
    expect(container.querySelector('.cinder-map-marker__anchor')).toBeNull();
  });

  test('a live marker draws a dot and names its state in text', () => {
    const { container } = render(MapMarker, { label: 'Live', state: 'live' });
    expect(container.querySelector('.cinder-map-marker__dot')).not.toBeNull();
    expect(container.querySelector('.cinder-sr-only')?.textContent).toBe(' live');
  });

  test('a selected marker is pressed; others are not', () => {
    const selected = render(MapMarker, { label: 'x', state: 'selected' });
    expect(selected.container.querySelector('button')?.getAttribute('aria-pressed')).toBe('true');
    selected.unmount();
    const idle = render(MapMarker, { label: 'x' });
    expect(idle.container.querySelector('button')?.hasAttribute('aria-pressed')).toBe(false);
  });

  test('an explicit name becomes the accessible name and drops the hidden state word', () => {
    const { container } = render(MapMarker, { label: '8 pm', state: 'live', name: 'Bar, live' });
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Bar, live');
    expect(container.querySelector('.cinder-sr-only')).toBeNull();
  });

  test('stylesheet keeps a 44px target and a 10px anchor, and selected has a ring', () => {
    const css = readFileSync(new URL('./map-marker.css', import.meta.url), 'utf8');
    expect(css).toMatch(/min-block-size: 44px/);
    expect(css).toMatch(/min-inline-size: 44px/);
    expect(css).toMatch(/\.cinder-map-marker__anchor \{[^}]*inline-size: 10px/);
    expect(css).toMatch(/data-state='selected'\] > \.cinder-map-marker__body \{[^}]*ring-color/);
  });
});
