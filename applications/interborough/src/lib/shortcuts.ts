/**
 * The keyboard shortcut registry: the one list of every key Interborough answers, and of the keys a
 * Cinder component answers itself. The shell reads each key press against it, and the `?` map
 * (Cinder's `KeyboardShortcuts`) lists it, so what the map says is what the keys do.
 *
 * An entry is `{ keys, label, group, scope, handler }`. `keys` is a sequence: `['g', 'c']` is `g`,
 * then `c`, within {@link CHORD_WINDOW_MS}. `scope` says where the keys act: everywhere
 * (`'global'`), on one route of the route table (`{ route: '/agents/:id' }`), or while focus is
 * inside one focus region (`{ region: 'memory-list' }`, an element carrying
 * `data-shortcut-region="memory-list"`). The same keys may be registered in scopes that can never
 * be active together; two registrations whose scopes can be are a programming error, and
 * registering the second throws.
 *
 * A component that handles keys itself, such as ListDetail's J and K, is {@link
 * ShortcutRegistry.describe described} rather than registered: it is listed, and checked for
 * overlap, but the registry never handles it.
 */

/** How long after the first key of a sequence the next one still counts. */
export const CHORD_WINDOW_MS = 1_000;

/** Where a shortcut acts: everywhere, on one route pattern, or inside one focus region. */
export type ShortcutScope = 'global' | { readonly route: string } | { readonly region: string };

/** One shortcut the registry lists. */
export interface ShortcutDescriptor {
  /** The key sequence, as `KeyboardEvent.key` reports each key: `['g', 'c']`, `['?']`. */
  readonly keys: readonly string[];
  /** What the shortcut does, as the `?` map says it. */
  readonly label: string;
  /** The heading the `?` map lists it under. */
  readonly group: string;
  /** Where the keys act. */
  readonly scope: ShortcutScope;
}

/** One shortcut the registry lists and handles. */
export interface ShortcutEntry extends ShortcutDescriptor {
  /** What the keys do. */
  readonly handler: () => void;
}

/** Where a key press happened: the route pattern on screen and the focus regions around the focus. */
export interface ShortcutContext {
  /** The pattern of the route on screen, or `null` for an address no route matches. */
  readonly routePattern: string | null;
  /** The focus regions that contain the focused element, innermost first. */
  readonly regions: readonly string[];
}

/** The part of a key event the registry reads, so a test needs no DOM. */
export interface ShortcutKey {
  /** The key, as `KeyboardEvent.key` reports it. */
  readonly key: string;
  /** Whether Meta (⌘) was held. */
  readonly metaKey: boolean;
  /** Whether Control was held. */
  readonly ctrlKey: boolean;
  /** Whether Alt (⌥) was held. */
  readonly altKey: boolean;
  /** Whether the key went to something the person is typing into. */
  readonly editable: boolean;
}

/** One group of the `?` map, in the shape Cinder's `KeyboardShortcuts` reads. */
export interface ShortcutGroupListing {
  /** The group's heading. */
  readonly label: string;
  /** Its shortcuts: what each does, and its keys as a keycap prints them. */
  readonly shortcuts: { action: string; keys: string[] }[];
}

/** What the registry holds for one registration: the descriptor, and its handler when it has one. */
interface Registration {
  readonly descriptor: ShortcutDescriptor;
  readonly handler: (() => void) | undefined;
}

/** A readable name for a scope in an error message. */
function describeScope(scope: ShortcutScope): string {
  if (scope === 'global') return 'global';
  return 'route' in scope ? `route ${scope.route}` : `region ${scope.region}`;
}

/**
 * Whether two scopes can be active at the same time. `global` is always active. A location matches
 * one route pattern, so two different patterns never are. A focus region can be open on any
 * route, so a route and a region can be. Focus is in one innermost region at a time, but regions
 * nest, so two regions overlap only when they are the same region.
 */
export function scopesOverlap(first: ShortcutScope, second: ShortcutScope): boolean {
  if (first === 'global' || second === 'global') return true;
  if ('route' in first && 'route' in second) return first.route === second.route;
  if ('region' in first && 'region' in second) return first.region === second.region;
  return true;
}

/**
 * Whether two key sequences collide: the same keys, or one the start of the other, because the
 * shorter one would act before the longer one could finish. A letter collides with its capital,
 * because a component such as ListDetail answers both.
 */
export function keysCollide(first: readonly string[], second: readonly string[]): boolean {
  const length = Math.min(first.length, second.length);
  for (let index = 0; index < length; index += 1) {
    if (first[index]?.toLowerCase() !== second[index]?.toLowerCase()) return false;
  }
  return true;
}

/** Whether `keys` starts with `sequence`, key for key as the event reports them. */
function startsWith(keys: readonly string[], sequence: readonly string[]): boolean {
  return sequence.length <= keys.length && sequence.every((key, index) => keys[index] === key);
}

/** Whether a scope is active in a context. */
function scopeActive(scope: ShortcutScope, context: ShortcutContext): boolean {
  if (scope === 'global') return true;
  if ('route' in scope) return scope.route === context.routePattern;
  return context.regions.includes(scope.region);
}

/** How a key sequence reads in the `?` map: a single letter in capitals, as a keycap prints it. */
function displayKey(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key;
}

/** The registry. The shell keeps one ({@link shortcuts}); a test makes its own. */
export class ShortcutRegistry {
  readonly #registrations: Registration[] = [];
  #pending: { readonly keys: readonly string[]; readonly atMs: number } | null = null;

  /**
   * Registers a shortcut the registry handles. Throws when a registration whose scope can be
   * active at the same time already uses the same keys, or keys that start the same way. Returns
   * the function that removes it again.
   */
  register(entry: ShortcutEntry): () => void {
    const { handler, ...descriptor } = entry;
    return this.#add({ descriptor, handler });
  }

  /**
   * Lists a shortcut a component handles itself, such as ListDetail's J and K. It is checked for
   * overlap like a registration, so an application key never shadows it, but never handled.
   */
  describe(descriptor: ShortcutDescriptor): () => void {
    return this.#add({ descriptor, handler: undefined });
  }

  #add(registration: Registration): () => void {
    const { descriptor } = registration;
    if (descriptor.keys.length === 0) throw new Error(`Shortcut "${descriptor.label}" has no keys`);
    const clash = this.#registrations.find(
      (existing) =>
        keysCollide(existing.descriptor.keys, descriptor.keys) &&
        scopesOverlap(existing.descriptor.scope, descriptor.scope),
    );
    if (clash !== undefined) {
      throw new Error(
        `Shortcut "${descriptor.label}" (${descriptor.keys.join(' ')}, ${describeScope(descriptor.scope)}) ` +
          `overlaps "${clash.descriptor.label}" (${clash.descriptor.keys.join(' ')}, ${describeScope(clash.descriptor.scope)})`,
      );
    }
    this.#registrations.push(registration);
    return () => {
      const index = this.#registrations.indexOf(registration);
      if (index !== -1) this.#registrations.splice(index, 1);
    };
  }

  /** Every listed shortcut, handled or not, in the order it was registered. */
  entries(): readonly ShortcutDescriptor[] {
    return this.#registrations.map((registration) => registration.descriptor);
  }

  /** The `?` map's groups, in the order each group was first registered. */
  groups(): ShortcutGroupListing[] {
    const groups = new Map<string, ShortcutGroupListing>();
    for (const { descriptor } of this.#registrations) {
      let group = groups.get(descriptor.group);
      if (group === undefined) {
        group = { label: descriptor.group, shortcuts: [] };
        groups.set(descriptor.group, group);
      }
      group.shortcuts.push({ action: descriptor.label, keys: descriptor.keys.map(displayKey) });
    }
    return [...groups.values()];
  }

  /**
   * Reads one key press. A sequence's first keys wait for the rest; the last key of a handled
   * shortcut active in `context` runs it. A modifier, or a key that
   * went to a field the person is typing into, drops the wait. Returns whether a shortcut ran, so
   * the caller can keep the browser from acting on the key as well.
   */
  handleKey(event: ShortcutKey, context: ShortcutContext, nowMs: number): boolean {
    if (event.editable || event.metaKey || event.ctrlKey || event.altKey) {
      this.#pending = null;
      return false;
    }
    const pending =
      this.#pending !== null && nowMs - this.#pending.atMs <= CHORD_WINDOW_MS
        ? this.#pending.keys
        : [];
    this.#pending = null;
    if (this.#step([...pending, event.key], context, nowMs)) return true;
    if (pending.length === 0 || this.#pending !== null) return false;
    // A key that does not continue the waiting sequence may start one of its own.
    return this.#step([event.key], context, nowMs);
  }

  #step(sequence: readonly string[], context: ShortcutContext, nowMs: number): boolean {
    const active = this.#registrations.filter(
      (registration) =>
        registration.handler !== undefined &&
        scopeActive(registration.descriptor.scope, context) &&
        startsWith(registration.descriptor.keys, sequence),
    );
    // Overlapping registrations are refused, so at most one complete match is active.
    const match = active.find(
      (registration) => registration.descriptor.keys.length === sequence.length,
    );
    if (match?.handler !== undefined) {
      match.handler();
      return true;
    }
    if (active.length > 0) this.#pending = { keys: sequence, atMs: nowMs };
    return false;
  }
}

/** The shell's registry. */
export const shortcuts = new ShortcutRegistry();
