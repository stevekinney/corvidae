import { describe, expect, it } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import type { IconComponent, IconProps } from './index.ts';
import * as icons from './index.ts';

setupHappyDom();
const { render, cleanup } = await import('@testing-library/svelte');
const { Link, LinkIcon, SendHorizontal } = await import('@lostgradient/cinder');

describe('icons/index', () => {
  it('exposes the Link icon separately from the Link component through the package root', () => {
    expect(LinkIcon).not.toBe(Link);
    const result = render(LinkIcon, { 'aria-label': 'Insert link' });
    try {
      expect(result.container.querySelector('svg')?.getAttribute('aria-label')).toBe('Insert link');
      expect(result.container.querySelector('a')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('exports SendHorizontal, the composer send glyph, from the package root and the icon set', () => {
    expect(icons.SendHorizontal).toBe(SendHorizontal);
    expect(icons.SendHorizontal).not.toBe(icons.ArrowUp);
    const result = render(SendHorizontal, { 'aria-label': 'Send' });
    try {
      const svg = result.container.querySelector('svg');
      expect(svg?.getAttribute('class')).toContain('lucide-send-horizontal');
      expect(svg?.getAttribute('aria-label')).toBe('Send');
    } finally {
      cleanup();
    }
  });

  it('exports TriangleAlert, the warning glyph of a blocked row, from the package root and the icon set', async () => {
    const { TriangleAlert } = await import('@lostgradient/cinder');
    expect(icons.TriangleAlert).toBe(TriangleAlert);
    const result = render(TriangleAlert, { 'aria-hidden': 'true' });
    try {
      expect(result.container.querySelector('svg')?.getAttribute('class')).toContain(
        'lucide-triangle-alert',
      );
    } finally {
      cleanup();
    }
  });

  it('exports SlidersHorizontal, the glyph of the composer’s Settings control, from the package root and the icon set', async () => {
    const { SlidersHorizontal } = await import('@lostgradient/cinder');
    expect(icons.SlidersHorizontal).toBe(SlidersHorizontal);
    const result = render(SlidersHorizontal, { 'aria-hidden': 'true' });
    try {
      expect(result.container.querySelector('svg')?.getAttribute('class')).toContain(
        'lucide-sliders-horizontal',
      );
    } finally {
      cleanup();
    }
  });

  it('types every exported icon as an IconComponent that takes size and stroke props alone', () => {
    // A type-level regression as much as a runtime one: `@lucide/svelte`'s own
    // `IconProps` requires icon data and its icons are Svelte 5 function
    // components, so an `IconProps` or `IconComponent` copied from it, or the
    // legacy class-component `ComponentType`, rejects these assignments.
    const props: IconProps = { size: 16, strokeWidth: 1.5, 'aria-label': 'More' };
    const renamedUpstream: IconComponent[] = [icons.MoreHorizontal, icons.Trash2];
    for (const icon of renamedUpstream) {
      const result = render(icon, props);
      try {
        const svg = result.container.querySelector('svg.lucide');
        expect(svg?.getAttribute('width')).toBe('16');
        expect(svg?.getAttribute('stroke-width')).toBe('1.5');
      } finally {
        cleanup();
      }
    }
  });

  it('exports the product vocabulary, one distinct icon per noun, from the package root', async () => {
    const root = (await import('@lostgradient/cinder')) as unknown as Record<string, unknown>;
    // Each noun of the vocabulary and the export that draws it. A noun the library already drew
    // before the vocabulary (search, list, check, warning, more, add) maps to its existing export.
    const vocabulary = {
      home: 'House',
      inbox: 'Inbox',
      today: 'Sun',
      search: 'Search',
      settings: 'Settings',
      saved: 'Bookmark',
      map: 'MapIcon',
      list: 'List',
      person: 'User',
      project: 'FolderKanban',
      area: 'Layers',
      calendar: 'CalendarIcon',
      place: 'MapPin',
      run: 'Play',
      agent: 'Bot',
      workflow: 'Workflow',
      schedule: 'CalendarClock',
      review: 'ClipboardCheck',
      clock: 'Clock',
      check: 'Check',
      warning: 'TriangleAlert',
      offline: 'WifiOff',
      share: 'Share',
      directions: 'Navigation',
      more: 'MoreHorizontal',
      add: 'Plus',
      filter: 'Funnel',
    } as const;
    const exported = icons as unknown as Record<string, unknown>;
    const names = Object.values(vocabulary);
    for (const [noun, name] of Object.entries(vocabulary)) {
      expect(typeof exported[name], `${noun} (${name}) is exported from the icon set`).toBe(
        'function',
      );
      expect(root[name], `${noun} (${name}) is exported from the package root`).toBe(
        exported[name],
      );
    }
    expect(new Set(names.map((name) => exported[name])).size, 'no noun shares a glyph').toBe(
      names.length,
    );
    // The map and the calendar are named apart from the global `Map` and the Calendar component.
    expect(root.Calendar).not.toBe(root.CalendarIcon);
    expect(exported.Map).toBeUndefined();
  });

  it('is decorative by default and named when it is labelled', () => {
    const decorative = render(icons.House);
    try {
      expect(decorative.container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    } finally {
      cleanup();
    }
    const labelled = render(icons.House, { 'aria-label': 'Home' });
    try {
      const svg = labelled.container.querySelector('svg');
      expect(svg?.getAttribute('aria-label')).toBe('Home');
      expect(svg?.hasAttribute('aria-hidden')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('sizes and strokes by the text it sits beside: 16, 20 and 24px', async () => {
    const css = await Bun.file(new URL('../../styles/utilities.css', import.meta.url)).text();
    expect(css).toMatch(/svg\.cinder-icon-sm\s*\{[^}]*width: 1rem;[^}]*height: 1rem;/);
    expect(css).toMatch(/svg\.cinder-icon-md\s*\{[^}]*width: 1\.25rem;[^}]*height: 1\.25rem;/);
    expect(css).toMatch(/svg\.cinder-icon-lg\s*\{[^}]*width: 1\.5rem;[^}]*height: 1\.5rem;/);
    expect(css).toMatch(/svg\.cinder-icon-sm\s*\{\s*stroke-width: 2;/);
    expect(css).toMatch(/svg\.cinder-icon-md\s*\{\s*stroke-width: 1\.75;/);
    expect(css).toMatch(/svg\.cinder-icon-lg\s*\{\s*stroke-width: 1\.5;/);
  });

  it('exports a non-empty set of distinct, function-shaped Svelte components', () => {
    const entries = Object.entries(icons);

    expect(entries.length).toBeGreaterThan(0);

    for (const [name, icon] of entries) {
      expect(typeof icon, `${name} should be a function (Svelte component)`).toBe('function');
    }

    const components = entries.map(([, icon]) => icon);
    expect(new Set(components).size, 'every export must have distinct identity (no aliasing)').toBe(
      components.length,
    );
  });
});
