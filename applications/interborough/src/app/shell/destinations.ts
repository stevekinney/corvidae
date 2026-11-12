/**
 * The sidebar's destinations, in the order it lists them, and the shortcuts the shell registers:
 * ⌘K for search, `c` for a new chat, `g` then a letter for each destination, and `?` for the map of
 * every shortcut. The sidebar's
 * tooltips name the same keys, so a destination's tooltip is what its keys do.
 */
import { LIST_DETAIL_SHORTCUTS } from '@lostgradient/cinder';
import {
  Bot,
  CalendarClock,
  HeartPulse,
  House,
  Inbox,
  Keyboard,
  MessageSquare,
  Play,
  Plus,
  Settings,
  Target,
  Webhook,
  Workflow,
  Wrench,
} from '@lucide/svelte';

import type { ShortcutRegistry } from '../../lib/shortcuts.ts';
import { SHORTCUT_COPY } from '../copy/shell.ts';
import { VIEW_COPY } from '../copy/view-pages.ts';
import type { ViewName } from '../views.ts';

/** The focus region of a ListDetail list: its keys act only there. */
export const LIST_DETAIL_REGION = 'list-detail';

/**
 * The sections the sidebar groups its destinations in: Home on its own at the top, then Work,
 * Build and System, which sits at the bottom of the column.
 */
export const DESTINATION_GROUPS = ['home', 'work', 'build', 'system'] as const;

/** One of {@link DESTINATION_GROUPS}. */
export type DestinationGroup = (typeof DESTINATION_GROUPS)[number];

/** One place the sidebar opens. */
export interface Destination {
  readonly view: ViewName;
  readonly path: string;
  /** The letter that follows `g`. */
  readonly letter: string;
  readonly icon: typeof Workflow;
  /** The section of the sidebar it sits in. */
  readonly group: DestinationGroup;
}

/** Every destination, in the sidebar's order. */
export const DESTINATIONS: readonly Destination[] = [
  { view: 'home', path: '/', letter: 'h', icon: House, group: 'home' },
  { view: 'chat', path: '/chats', letter: 'c', icon: MessageSquare, group: 'work' },
  { view: 'reviews', path: '/reviews', letter: 'r', icon: Inbox, group: 'work' },
  { view: 'runs', path: '/runs', letter: 'u', icon: Play, group: 'work' },
  { view: 'agents', path: '/agents', letter: 'a', icon: Bot, group: 'build' },
  { view: 'workflows', path: '/workflows', letter: 'w', icon: Workflow, group: 'build' },
  { view: 'schedules', path: '/schedules', letter: 's', icon: CalendarClock, group: 'build' },
  { view: 'goals', path: '/goals', letter: 'l', icon: Target, group: 'build' },
  { view: 'capabilities', path: '/capabilities', letter: 'p', icon: Wrench, group: 'build' },
  { view: 'hooks', path: '/hooks', letter: 'k', icon: Webhook, group: 'build' },
  { view: 'health', path: '/health', letter: 'e', icon: HeartPulse, group: 'system' },
  // The gear is Settings; the sliders icon in the top bar is quick settings.
  { view: 'settings', path: '/settings', letter: 'n', icon: Settings, group: 'system' },
];

/**
 * The destinations the phone's bottom tab bar shows, in order, before its More tab: the places a
 * thumb goes most. Everything else is behind More, in the navigation drawer.
 */
export const TAB_BAR_VIEWS: readonly ViewName[] = ['home', 'chat', 'reviews', 'runs'];

/**
 * Whether `pathname` is inside the destination at `path`. Home is only `/`, because every other
 * path begins with it; any other destination owns its own path and what is below it.
 */
export function isActiveDestinationPath(pathname: string, path: string): boolean {
  if (path === '/') return pathname === '/';
  return pathname === path || pathname.startsWith(`${path}/`);
}

/** The key sequence that opens a destination, such as `['g', 'c']`. */
export function destinationKeys(destination: { readonly letter: string }): readonly string[] {
  return ['g', destination.letter];
}

/** The key that opens the search palette when held with ⌘. */
export const SEARCH_KEY = 'k';

/** The key that starts a new chat. */
export const NEW_CHAT_KEY = 'c';

/** Where the new-chat shortcut goes. */
export const NEW_CHAT_PATH = '/chats/new';

/**
 * The pages under Health that have a shortcut of their own, though the sidebar lists only Health:
 * `g` then `o` for Workers (`w` is Workflows, and `e` is Health), `g` then `t` for Storage and
 * `g` then `d` for the audit log (`u` is Runs).
 */
export const HEALTH_SHORTCUTS: readonly {
  readonly view: ViewName;
  readonly path: string;
  readonly letter: string;
}[] = [
  { view: 'workers', path: '/health/workers', letter: 'o' },
  { view: 'storage', path: '/health/storage', letter: 't' },
  { view: 'audit', path: '/health/audit', letter: 'd' },
];

/**
 * The glyph the command palette draws before an action: the destination's own icon for a "Go to"
 * row (the pages under Health use Health's), a plus for New chat, and the keyboard for the map.
 */
export function actionIcon(label: string): typeof Workflow {
  const destination = DESTINATIONS.find(
    (candidate) => SHORTCUT_COPY.goTo(VIEW_COPY[candidate.view].label) === label,
  );
  if (destination !== undefined) return destination.icon;
  if (HEALTH_SHORTCUTS.some((page) => SHORTCUT_COPY.goTo(VIEW_COPY[page.view].label) === label)) {
    return HeartPulse;
  }
  return label === SHORTCUT_COPY.newChat ? Plus : Keyboard;
}

/** What the shell's shortcuts do when they run. */
export interface ShellShortcutActions {
  /** Opens a path. */
  readonly navigate: (path: string) => void;
  /** Opens the map of every shortcut. */
  readonly openShortcutMap: () => void;
  /** Opens the search palette. */
  readonly openPalette: () => void;
}

/**
 * Registers the shell's shortcuts in `registry`, and lists the keys Cinder components handle
 * themselves. Returns the function that removes them all again.
 */
export function registerShellShortcuts(
  registry: ShortcutRegistry,
  actions: ShellShortcutActions,
): () => void {
  const removals = [
    // ⌘K is held with ⌘ (Control elsewhere), so it acts from inside a field too.
    registry.register({
      keys: [SEARCH_KEY],
      modifier: 'mod',
      label: SHORTCUT_COPY.openSearch,
      group: SHORTCUT_COPY.generalGroup,
      scope: 'global',
      handler: actions.openPalette,
    }),
    registry.register({
      keys: ['?'],
      label: SHORTCUT_COPY.openMap,
      group: SHORTCUT_COPY.generalGroup,
      scope: 'global',
      alwaysOn: true,
      handler: actions.openShortcutMap,
    }),
    // C starts a chat, wherever the person is; typing a "c" into a field never reaches it.
    registry.register({
      keys: [NEW_CHAT_KEY],
      label: SHORTCUT_COPY.newChat,
      group: SHORTCUT_COPY.chatGroup,
      scope: 'global',
      handler: () => actions.navigate(NEW_CHAT_PATH),
    }),
    ...DESTINATIONS.map((destination) =>
      registry.register({
        keys: destinationKeys(destination),
        label: SHORTCUT_COPY.goTo(VIEW_COPY[destination.view].label),
        group: SHORTCUT_COPY.navigationGroup,
        scope: 'global',
        handler: () => actions.navigate(destination.path),
      }),
    ),
    ...HEALTH_SHORTCUTS.map((page) =>
      registry.register({
        keys: ['g', page.letter],
        label: SHORTCUT_COPY.goTo(VIEW_COPY[page.view].label),
        group: SHORTCUT_COPY.navigationGroup,
        scope: 'global',
        handler: () => actions.navigate(page.path),
      }),
    ),
    // ListDetail handles its own keys while focus is in its list, on whichever page uses it.
    ...LIST_DETAIL_SHORTCUTS.map((shortcut) =>
      registry.describe({
        keys: shortcut.keys,
        label: shortcut.label,
        group: SHORTCUT_COPY.listGroup,
        scope: { region: LIST_DETAIL_REGION },
      }),
    ),
  ];
  return () => {
    for (const remove of removals) remove();
  };
}
