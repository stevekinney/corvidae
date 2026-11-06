/**
 * The sections of Settings (COR-1837): the section navigation lists General, Models, Allowed models, A2A, Plugins, Data and retention, and
 * API reference, marks the one that is open, and moves between them. Data and retention and API
 * reference are tested with their own pages (`retention/retention-page.test.ts`,
 * `api-reference/api-reference-page.test.ts`).
 */
import { fireEvent, render } from '@testing-library/svelte';
import { beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { router } from '../../lib/router.svelte.ts';
import SettingsSectionNav from './settings-section-nav.svelte';
import { SETTINGS_SECTIONS } from './settings-sections.ts';

/** Gives the window a real origin, which `history.pushState` needs, then opens `path`. */
function openAt(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

beforeEach(() => openAt('/settings/data-and-retention'));

describe('the section navigation', () => {
  test('lists every section in order, each linking to its own route', () => {
    const { getByRole } = render(SettingsSectionNav);
    const links = [...getByRole('navigation', { name: 'Settings sections' }).querySelectorAll('a')];
    expect(links.map((link) => link.textContent?.trim())).toEqual([
      'General',
      'Models',
      'Allowed models',
      'A2A',
      'Plugins',
      'Data and retention',
      'API reference',
    ]);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      SETTINGS_SECTIONS.map((section) => section.path),
    );
    expect(SETTINGS_SECTIONS.map((section) => section.path)).toEqual([
      '/settings',
      '/settings/models',
      '/settings/allowed-models',
      '/settings/a2a',
      '/settings/plugins',
      '/settings/data-and-retention',
      '/settings/api-reference',
    ]);
  });

  test('marks the open section as the current page, and only that one', () => {
    const { getByRole } = render(SettingsSectionNav);
    const current = [...getByRole('navigation').querySelectorAll('a[aria-current="page"]')];
    expect(current.map((link) => link.textContent?.trim())).toEqual(['Data and retention']);
  });

  test('is a Section select below 640px, reading the open section and opening another on change', async () => {
    if (!(window instanceof Window)) throw new Error('expected a happy-dom window');
    window.happyDOM.setViewport({ width: 375, height: 800 });
    try {
      const { getByRole, queryByRole } = render(SettingsSectionNav);
      expect(queryByRole('navigation')).toBeNull();
      const select = getByRole('combobox', { name: 'Section' }) as HTMLSelectElement;
      // The label shows above the select (boards ResponsiveAndDark, "Phone", rows 06s and 06t).
      const label = document.querySelector<HTMLElement>('label[for="weft-settings-section"]');
      expect(label?.textContent?.trim()).toBe('Section');
      expect(label?.className).not.toContain('visually-hidden');
      expect(select.value).toBe('/settings/data-and-retention');
      expect([...select.options].map((option) => option.textContent?.trim())).toEqual([
        'General',
        'Models',
        'Allowed models',
        'A2A',
        'Plugins',
        'Data and retention',
        'API reference',
      ]);
      await fireEvent.change(select, { target: { value: '/settings/a2a' } });
      expect(router.pathname).toBe('/settings/a2a');
    } finally {
      window.happyDOM.setViewport({ width: 1024, height: 768 });
    }
  });

  test('opens a section in the client router when its link is clicked', async () => {
    const { getByRole } = render(SettingsSectionNav);
    await fireEvent.click(getByRole('link', { name: 'API reference' }));
    expect(router.pathname).toBe('/settings/api-reference');
  });
});
