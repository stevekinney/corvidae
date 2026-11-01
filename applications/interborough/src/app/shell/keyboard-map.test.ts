/**
 * The keyboard map (`?`) and the registry behind it (row 25f): the registry holds every key the
 * design lists (⌘K, ?, C, G then a letter for each place, J and K in lists, A and D to decide, 1 to 9
 * to pick a choice, ⌘Enter to save), and the map lists exactly what is registered, so a key
 * added later appears in it with no second list to edit.
 *
 * The keys a page registers exist only while the page is on screen, so the test mounts the two
 * pages that hold them (Reviews, Settings) over the shell's own registrations, which is how a
 * person meets them.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { toolApprovalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import type { BureauStub } from '../../lib/bureau-stub.test-support.ts';
import type { BureauWorldStub } from '../../lib/bureau-world.test-support.ts';
import { emptyBureauWorld, installBureauWorld } from '../../lib/bureau-world.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { ShortcutRegistry, shortcuts, type ShortcutDescriptor } from '../../lib/shortcuts.ts';
import { landAt } from '../../routes/chat/pages.test-support.ts';
import Reviews from '../../routes/reviews/reviews-shell.test-harness.svelte';
import {
  installSettingsBureau,
  servedSettings,
} from '../../routes/settings/settings-fixtures.test-support.ts';
import { SETTINGS_COPY, SHORTCUT_COPY } from '../copy.ts';
import { DESTINATIONS, HEALTH_SHORTCUTS, registerShellShortcuts } from './destinations.ts';
import RouteOutletHarness from './route-outlet.test-harness.svelte';
import ShortcutMap from './shortcut-map.svelte';

let reviewsWorld: BureauWorldStub | undefined;
let settingsBureau: BureauStub | undefined;
let removeShell: (() => void) | undefined;

afterEach(() => {
  cleanup();
  reviewsWorld?.restore();
  reviewsWorld = undefined;
  settingsBureau?.restore();
  settingsBureau = undefined;
  removeShell?.();
  removeShell = undefined;
});

/** A key sequence, in lower case: `⌘+enter`, `g c`. */
function spell(entry: ShortcutDescriptor): string {
  return `${entry.modifier === 'mod' ? '⌘+' : ''}${entry.keys.join(' ')}`.toLowerCase();
}

function spelled(): string[] {
  return shortcuts.entries().map(spell);
}

function startAtHome(): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
}

function registerShell(): void {
  removeShell = registerShellShortcuts(shortcuts, {
    navigate: (path) => router.navigate(path),
    openShortcutMap: () => {},
    openPalette: () => {},
  });
}

/** Row 25f: every key the design lists. */
const KEYBOARD_ROW = {
  search: ['⌘+k'],
  map: ['?'],
  newChat: ['c'],
  goTo: [
    ...DESTINATIONS.map((destination) => destination.letter),
    ...HEALTH_SHORTCUTS.map((page) => page.letter),
  ].map((letter) => `g ${letter}`),
  list: ['j', 'k'],
  decide: ['a', 'd'],
  pick: Array.from({ length: 9 }, (_, index) => String(index + 1)),
  save: ['⌘+enter'],
};

describe('the registry holds row 25f', () => {
  test('the shell registers ⌘K, ?, C, every G letter, and lists J and K', () => {
    registerShell();
    const held = new Set(spelled());

    for (const key of [
      ...KEYBOARD_ROW.search,
      ...KEYBOARD_ROW.map,
      ...KEYBOARD_ROW.newChat,
      ...KEYBOARD_ROW.goTo,
      ...KEYBOARD_ROW.list,
    ]) {
      expect(held.has(key), key).toBe(true);
    }
    // Eleven places in the sidebar, and Workers, Storage and the audit log under Health.
    expect(KEYBOARD_ROW.goTo).toHaveLength(14);
    expect(new Set(KEYBOARD_ROW.goTo).size).toBe(14);
  });

  test('Reviews registers A and D and the digits 1 to 9, only while it is on screen', async () => {
    registerShell();
    expect(spelled()).not.toContain('a');

    reviewsWorld = installBureauWorld(emptyBureauWorld({ reviews: [toolApprovalFixture()] }));
    startAtHome();
    router.navigate('/reviews', { replace: true });
    const view = render(Reviews, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never);
    await waitFor(() => expect(spelled()).toContain('a'));

    const held = new Set(spelled());
    for (const key of [...KEYBOARD_ROW.decide, ...KEYBOARD_ROW.pick]) {
      expect(held.has(key), key).toBe(true);
    }

    view.unmount();
    expect(spelled()).not.toContain('a');
  });

  test('Settings registers ⌘Enter to save, only while it is on screen', async () => {
    registerShell();
    expect(spelled()).not.toContain('⌘+enter');

    settingsBureau = installSettingsBureau(servedSettings());
    landAt('/settings');
    const view = render(RouteOutletHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never);
    await view.findByRole('group', { name: SETTINGS_COPY.formLabel });

    for (const key of KEYBOARD_ROW.save) expect(spelled()).toContain(key);

    view.unmount();
    expect(spelled()).not.toContain('⌘+enter');
  });
});

describe('the ? map', () => {
  function register(registry: ShortcutRegistry): void {
    registerShellShortcuts(registry, {
      navigate: () => {},
      openShortcutMap: () => {},
      openPalette: () => {},
    });
    registry.register({
      keys: ['Enter'],
      modifier: 'mod',
      label: 'Save the settings',
      group: 'Settings',
      scope: { route: '/settings' },
      handler: () => {},
    });
    registry.register({
      keys: ['a'],
      label: 'Approve',
      group: 'Reviews',
      scope: { route: '/reviews' },
      handler: () => {},
    });
  }

  /** What the map shows: each heading, and under it each action with the keys it prints. */
  function shown(): { label: string; shortcuts: [string, string][] }[] {
    return [...document.body.querySelectorAll('.cinder-keyboard-shortcuts__group')].map(
      (group) => ({
        label:
          group.querySelector('.cinder-keyboard-shortcuts__group-label')?.textContent?.trim() ?? '',
        shortcuts: [...group.querySelectorAll('.cinder-keyboard-shortcuts__row')].map((row) => [
          row.querySelector('.cinder-keyboard-shortcuts__action')?.textContent?.trim() ?? '',
          [...row.querySelectorAll('.cinder-keyboard-shortcuts__keys-visual kbd')]
            .map((key) => key.textContent?.trim() ?? '')
            .join(' '),
        ]),
      }),
    );
  }

  test('lists exactly what is registered, under the headings it was registered with', async () => {
    const registry = new ShortcutRegistry();
    register(registry);
    render(ShortcutMap, { props: { registry, open: true } });

    await waitFor(() => expect(shown().length).toBeGreaterThan(0));
    expect(shown()).toEqual(
      registry.groups().map((group) => ({
        label: group.label,
        shortcuts: group.shortcuts.map((shortcut) => [shortcut.action, shortcut.keys.join(' ')]),
      })),
    );
    const total = shown().reduce((count, group) => count + group.shortcuts.length, 0);
    expect(total).toBe(registry.entries().length);
  });

  test('lists a shortcut registered after it was first opened, with nothing else to edit', async () => {
    const registry = new ShortcutRegistry();
    register(registry);
    const view = render(ShortcutMap, { props: { registry, open: true } });
    await waitFor(() => expect(shown().length).toBeGreaterThan(0));

    const remove = registry.register({
      keys: ['x'],
      label: 'Archive the chat',
      group: 'Chat',
      scope: 'global',
      handler: () => {},
    });
    await view.rerender({ registry, open: false });
    await view.rerender({ registry, open: true });

    await waitFor(() =>
      expect(shown().flatMap((group) => group.shortcuts)).toContainEqual(['Archive the chat', 'X']),
    );
    remove();
  });

  test('names itself with the title of the map, and shows nothing while closed', async () => {
    const registry = new ShortcutRegistry();
    register(registry);
    const view = render(ShortcutMap, { props: { registry, open: false } });
    expect(shown()).toEqual([]);

    await view.rerender({ registry, open: true });

    expect(await view.findByText(SHORTCUT_COPY.mapTitle)).not.toBeNull();
    await fireEvent.keyDown(document.body, { key: 'Escape' });
  });
});
