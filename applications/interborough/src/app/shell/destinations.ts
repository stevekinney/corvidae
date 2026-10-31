/**
 * The sidebar's destinations, in the order it lists them, and the shortcuts the shell registers:
 * `g` then a letter for each destination, and `?` for the map of every shortcut. The sidebar's
 * tooltips name the same keys, so a destination's tooltip is what its keys do.
 */
import { LIST_DETAIL_SHORTCUTS } from '@lostgradient/cinder';
import {
  Bot,
  CalendarClock,
  HeartPulse,
  Inbox,
  MessageSquare,
  Play,
  SlidersHorizontal,
  Workflow,
  Wrench,
} from '@lucide/svelte';

import type { ShortcutRegistry } from '../../lib/shortcuts.ts';
import { SHORTCUT_COPY, VIEW_COPY } from '../copy.ts';
import type { ViewName } from '../views.ts';

/** The focus region of a ListDetail list: its keys act only there. */
export const LIST_DETAIL_REGION = 'list-detail';

/** One place the sidebar opens. */
export interface Destination {
  readonly view: ViewName;
  readonly path: string;
  /** The letter that follows `g`. */
  readonly letter: string;
  readonly icon: typeof Workflow;
  /** Whether the sidebar pins it to the bottom, under the rest. */
  readonly pinned: boolean;
}

/** Every destination, in the sidebar's order. Settings is pinned to the bottom. */
export const DESTINATIONS: readonly Destination[] = [
  { view: 'chat', path: '/chats', letter: 'c', icon: MessageSquare, pinned: false },
  { view: 'reviews', path: '/reviews', letter: 'v', icon: Inbox, pinned: false },
  { view: 'agents', path: '/agents', letter: 'a', icon: Bot, pinned: false },
  { view: 'capabilities', path: '/capabilities', letter: 'p', icon: Wrench, pinned: false },
  { view: 'workflows', path: '/workflows', letter: 'w', icon: Workflow, pinned: false },
  { view: 'runs', path: '/runs', letter: 'r', icon: Play, pinned: false },
  { view: 'schedules', path: '/schedules', letter: 's', icon: CalendarClock, pinned: false },
  { view: 'health', path: '/health', letter: 'e', icon: HeartPulse, pinned: false },
  { view: 'settings', path: '/settings', letter: 'n', icon: SlidersHorizontal, pinned: true },
];

/** The key sequence that opens a destination, such as `['g', 'c']`. */
export function destinationKeys(destination: Destination): readonly string[] {
  return ['g', destination.letter];
}

/** What the shell's shortcuts do when they run. */
export interface ShellShortcutActions {
  /** Opens a path. */
  readonly navigate: (path: string) => void;
  /** Opens the map of every shortcut. */
  readonly openShortcutMap: () => void;
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
    registry.register({
      keys: ['?'],
      label: SHORTCUT_COPY.openMap,
      group: SHORTCUT_COPY.generalGroup,
      scope: 'global',
      handler: actions.openShortcutMap,
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
