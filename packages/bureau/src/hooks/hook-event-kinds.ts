/**
 * COR-2226 — the event kinds a hook lists, and how each entry of its `events` reads against what is
 * loaded now.
 *
 * A hook lists a core kind as it is (`run.completed`). It lists a kind a running plugin declares
 * (`<plugin>:<name>`) pinned to the declaration's version, as the hook is written:
 * `reports:digest-ready@1.0.0`, the version being the declaration's own `version`, else its
 * plugin's (the COR-1879 rule `PluginEventListing.version` already follows). The pin is resolved
 * the way a pinned record is (`versioned-catalog.ts`): exactly that version, never another. A
 * pinned kind whose plugin is not loaded, or is loaded at another version, is `missing`; it fires
 * nothing and the hook lists it as a problem, while its other kinds still fire. A kind is
 * namespaced by its plugin, so a pin never matches another plugin's kind of the same name.
 *
 * @module hook-event-kinds
 */

import { PUBLISHED_BUREAU_EVENT_KINDS } from '../bureau-event-feed.ts';
import { formatVersionedId, parseVersionedId } from '../versioned-catalog.ts';

const CORE_KINDS: ReadonlySet<string> = new Set(PUBLISHED_BUREAU_EVENT_KINDS);

/** A kind a running plugin declares, at the version a hook that lists it pins. */
export interface DeclaredHookEventKind {
  /** The kind, `<plugin>:<name>`. */
  readonly kind: string;
  /** The declaration's own version, else its plugin's. */
  readonly version: string;
}

/** The declared kinds by kind, each with its version. A later listing of a kind never replaces the first. */
export function declaredVersionsOf(
  declared: readonly DeclaredHookEventKind[],
): ReadonlyMap<string, string> {
  const versions = new Map<string, string>();
  for (const { kind, version } of declared) {
    if (!versions.has(kind)) versions.set(kind, version);
  }
  return versions;
}

/** How one entry of a hook's `events` reads now. */
export type HookEventResolution =
  /** A kind the Bureau itself publishes. */
  | { readonly status: 'core' }
  /** A plugin's kind, pinned to the version that is loaded now. */
  | { readonly status: 'current'; readonly kind: string }
  /**
   * A plugin's kind that fires nothing now: its plugin is not loaded (`loadedVersion` is
   * `undefined`), or is loaded at another version, or the entry has no pin at all.
   */
  | { readonly status: 'missing'; readonly kind: string; readonly loadedVersion?: string };

/** How `entry`, one entry of a stored hook's `events`, reads against the kinds `declared` now. */
export function resolveHookEvent(
  entry: string,
  declared: ReadonlyMap<string, string>,
): HookEventResolution {
  if (CORE_KINDS.has(entry)) return { status: 'core' };
  const pinned = parseVersionedId(entry);
  const kind = pinned?.name ?? entry;
  const loadedVersion = declared.get(kind);
  if (pinned !== undefined && loadedVersion === pinned.version) return { status: 'current', kind };
  return loadedVersion === undefined
    ? { status: 'missing', kind }
    : { status: 'missing', kind, loadedVersion };
}

/** The kind an entry names, without its pin: `reports:digest-ready@1.0.0` names `reports:digest-ready`. */
export function hookEventKindOf(entry: string): string {
  if (CORE_KINDS.has(entry)) return entry;
  return parseVersionedId(entry)?.name ?? entry;
}

/** Whether a stored hook's `events` lists `kind`, an event's kind, as it fires now. */
export function hookEventsMatch(
  events: readonly string[],
  kind: string,
  declared: ReadonlyMap<string, string>,
): boolean {
  if (CORE_KINDS.has(kind)) return events.includes(kind);
  const version = declared.get(kind);
  return version !== undefined && events.includes(formatVersionedId(kind, version));
}

/** What an entry of `hooks.create`, `hooks.update` or a declaration comes to. */
export type HookEventInput =
  /** The entry as the hook stores it: a core kind, or a declared kind pinned to its version. */
  | { readonly ok: true; readonly entry: string }
  /**
   * `missing`: a pinned kind that fires nothing now, kept only on a hook that already lists it.
   * `unknown`: not a kind a hook can list.
   */
  | {
      readonly ok: false;
      readonly entry: string;
      readonly reason: 'missing' | 'unknown';
      readonly message: string;
    };

/**
 * Reads one entry a caller asks a hook to list: a core kind as it is; a kind a running plugin
 * declares, pinned to its version now; a pinned kind at the version loaded now as it is; a pinned
 * kind that is `missing` now, for the caller to keep only where the hook already lists it; and
 * anything else refused.
 */
export function hookEventInputOf(
  entry: string,
  declared: ReadonlyMap<string, string>,
): HookEventInput {
  if (CORE_KINDS.has(entry)) return { ok: true, entry };
  const version = declared.get(entry);
  if (version !== undefined) return { ok: true, entry: formatVersionedId(entry, version) };
  const pinned = parseVersionedId(entry);
  if (pinned === undefined || !pinned.name.includes(':')) {
    return {
      ok: false,
      entry,
      reason: 'unknown',
      message: `"${entry}" is not a published Bureau event kind, nor one a running plugin declares`,
    };
  }
  const loaded = declared.get(pinned.name);
  if (loaded === pinned.version) return { ok: true, entry };
  return {
    ok: false,
    entry,
    reason: 'missing',
    message:
      loaded === undefined
        ? `"${entry}" is missing: no running plugin declares ${pinned.name}`
        : `"${entry}" is missing: ${pinned.name} is loaded at ${loaded}, not ${pinned.version}`,
  };
}
