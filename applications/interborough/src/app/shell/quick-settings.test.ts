/**
 * Quick settings (design row 02y): the sliders icon opens a popover titled "Quick settings" with a
 * Theme row (the theme switch), a Sidebar row (Expanded or Collapsed) and "All settings". There is
 * no density switch.
 */
import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { router } from '../../lib/router.svelte.ts';
import { LayoutPreferences } from '../layout-preferences.svelte.ts';
import { ThemeStore } from '../theme.svelte.ts';
import QuickSettings from './quick-settings.svelte';

afterEach(() => {
  window.localStorage.clear();
});

function landAt(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

function mount() {
  const layout = new LayoutPreferences(window.localStorage);
  const theme = new ThemeStore(document.documentElement, window.localStorage);
  const view = render(QuickSettings, { props: { theme, layout } });
  return { ...view, layout, theme };
}

async function open(view: ReturnType<typeof mount>) {
  await fireEvent.click(view.getByRole('button', { name: 'Quick settings' }));
  return view.findByRole('dialog', { name: 'Quick settings' });
}

describe('quick settings', () => {
  test('is the sliders icon, not the gear that is Settings', () => {
    const view = mount();

    const icon = view.getByRole('button', { name: 'Quick settings' }).querySelector('svg');
    expect(icon?.getAttribute('class')).toContain('lucide-sliders-horizontal');
  });

  test('is titled Quick settings, with a Theme row, a Sidebar row and All settings, and no density', async () => {
    const view = mount();

    const panel = await open(view);

    expect(within(panel).getByRole('heading', { name: 'Quick settings' })).not.toBeNull();
    const rows = Array.from(panel.querySelectorAll('.weft-quick-settings__row')).map((row) =>
      row.querySelector('.weft-quick-settings__label')?.textContent?.trim(),
    );
    expect(rows).toEqual(['Theme', 'Sidebar']);
    expect(
      within(panel)
        .getAllByRole('radio')
        .map((radio) => radio.getAttribute('aria-label') ?? radio.textContent?.trim()),
    ).toEqual(['Light', 'System', 'Dark', 'Expanded', 'Collapsed']);
    expect(panel.textContent).not.toMatch(/density|comfortable|compact/i);
    const link = within(panel).getByRole('link', { name: 'All settings' });
    expect(link.querySelector('svg.lucide-settings')).not.toBeNull();
    expect(link.querySelector('svg.lucide-chevron-right')).not.toBeNull();
  });

  test('offers no Sidebar row on a phone, which has no sidebar to expand or collapse', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((media: string) => ({
      matches: media.includes('width < 640px'),
      media,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    try {
      const view = mount();
      const panel = await open(view);

      const rows = Array.from(panel.querySelectorAll('.weft-quick-settings__row')).map((row) =>
        row.querySelector('.weft-quick-settings__label')?.textContent?.trim(),
      );
      expect(rows).toEqual(['Theme']);
    } finally {
      window.matchMedia = original;
    }
  });

  test('the theme switch sets the theme', async () => {
    const view = mount();
    const panel = await open(view);

    await fireEvent.click(within(panel).getByRole('radio', { name: 'Dark' }));

    expect(view.theme.mode).toBe('dark');
  });

  test('the Sidebar choice shows the preference and sets it, remembered across a reload', async () => {
    const view = mount();
    const panel = await open(view);
    expect(
      within(panel).getByRole('radio', { name: 'Expanded' }).getAttribute('aria-checked'),
    ).toBe('true');

    await fireEvent.click(within(panel).getByRole('radio', { name: 'Collapsed' }));

    expect(view.layout.sidebarCollapsed).toBe(true);
    expect(new LayoutPreferences(window.localStorage).sidebarCollapsed).toBe(true);
    expect(
      within(panel).getByRole('radio', { name: 'Collapsed' }).getAttribute('aria-checked'),
    ).toBe('true');

    await fireEvent.click(within(panel).getByRole('radio', { name: 'Expanded' }));

    expect(view.layout.sidebarCollapsed).toBe(false);
  });

  test('All settings opens Settings and closes the popover', async () => {
    landAt('/agents');
    const view = mount();
    const panel = await open(view);

    await fireEvent.click(within(panel).getByRole('link', { name: 'All settings' }));

    expect(router.pathname).toBe('/settings');
    await waitFor(() =>
      expect(view.queryByRole('dialog', { name: 'Quick settings' })?.outerHTML ?? null).toBeNull(),
    );
  });
});
