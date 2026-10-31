/**
 * The choices Settings › Plugins holds before they are applied: which plugins are switched on or
 * off, and the configuration text a person edited. Nothing here reaches the host. A choice is kept
 * only while it differs from what the host has stored, so putting a switch back, or the text as it
 * was, leaves nothing pending. Applying them is one step with the restart (`restart-flow.svelte.ts`):
 * each changed plugin is written with `PUT /host/plugins/<name>`, then the host restarts.
 *
 * The host reports a plugin's stored configuration but not the schema it is checked against, so
 * the page edits it as JSON and cannot say which keys exist. A draft that is not an object is held
 * but never applied, and `invalid` says so.
 */
import { SvelteMap } from 'svelte/reactivity';

import type { PluginStanding, PluginsSnapshot } from '../../../lib/host-plugins.ts';

/** One plugin's write: only the fields a person changed. */
export type PluginWrite = {
  readonly name: string;
  readonly enabled?: boolean;
  readonly configuration?: Record<string, unknown>;
};

/** The stored configuration as the editor shows it. */
export function configurationText(configuration: unknown): string {
  return JSON.stringify(configuration ?? {}, null, 2);
}

/** What a draft's text means: the object it parses to, or why it is not one. */
export function parseConfiguration(
  text: string,
): { readonly value: Record<string, unknown> } | { readonly error: 'syntax' | 'shape' } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'syntax' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'shape' };
  }
  return { value: Object.fromEntries(Object.entries(parsed)) };
}

/** Whether two configurations are the same value, regardless of key order. */
function sameConfiguration(first: unknown, second: unknown): boolean {
  return canonical(first) === canonical(second);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The drafts of one page. */
export class PluginDrafts {
  readonly #enabled = new SvelteMap<string, boolean>();
  readonly #configuration = new SvelteMap<string, string>();

  /** Whether the plugin is switched on in the page: the draft, or what the host has stored. */
  enabledOf(plugin: PluginStanding): boolean {
    return this.#enabled.get(plugin.descriptor.name) ?? plugin.enabled;
  }

  /** The configuration text in the editor: the draft, or what the host has stored. */
  configurationOf(plugin: PluginStanding): string {
    return (
      this.#configuration.get(plugin.descriptor.name) ?? configurationText(plugin.configuration)
    );
  }

  /** Switches a plugin on or off. Putting it back to what is stored removes the draft. */
  setEnabled(plugin: PluginStanding, enabled: boolean): void {
    const name = plugin.descriptor.name;
    if (enabled === plugin.enabled) this.#enabled.delete(name);
    else this.#enabled.set(name, enabled);
  }

  /** Edits a plugin's configuration text. Text that means what is stored removes the draft. */
  setConfiguration(plugin: PluginStanding, text: string): void {
    const name = plugin.descriptor.name;
    const parsed = parseConfiguration(text);
    if ('value' in parsed && sameConfiguration(parsed.value, plugin.configuration)) {
      this.#configuration.delete(name);
    } else {
      this.#configuration.set(name, text);
    }
  }

  /** Why the plugin's configuration text cannot be applied, or `undefined` when it can. */
  invalid(plugin: PluginStanding): 'syntax' | 'shape' | undefined {
    const text = this.#configuration.get(plugin.descriptor.name);
    if (text === undefined) return undefined;
    const parsed = parseConfiguration(text);
    return 'error' in parsed ? parsed.error : undefined;
  }

  /** Whether any configuration text cannot be applied. */
  hasInvalid(snapshot: PluginsSnapshot): boolean {
    return snapshot.plugins.some((plugin) => this.invalid(plugin) !== undefined);
  }

  /** Whether the page holds a choice the host does not have yet. */
  get hasDrafts(): boolean {
    return this.#enabled.size > 0 || this.#configuration.size > 0;
  }

  /**
   * Drops the drafts the host now holds as stored choices, which is what is left of a write that
   * reached some plugins before it failed, or a change made somewhere else in the meantime.
   */
  reconcile(snapshot: PluginsSnapshot): void {
    for (const plugin of snapshot.plugins) {
      const name = plugin.descriptor.name;
      if (this.#enabled.get(name) === plugin.enabled) this.#enabled.delete(name);
      const text = this.#configuration.get(name);
      if (text === undefined) continue;
      const parsed = parseConfiguration(text);
      if ('value' in parsed && sameConfiguration(parsed.value, plugin.configuration)) {
        this.#configuration.delete(name);
      }
    }
  }

  /** Drops every draft. */
  discard(): void {
    this.#enabled.clear();
    this.#configuration.clear();
  }

  /**
   * How many changes wait for a restart: each switch and each edited configuration the page holds,
   * and each plugin whose stored choices the host already reports as not loaded yet.
   */
  changeCount(snapshot: PluginsSnapshot): number {
    let count = 0;
    const named = new Set<string>();
    for (const plugin of snapshot.plugins) {
      const name = plugin.descriptor.name;
      // The host stores choices by name, and they belong to the first plugin with it.
      const first = !named.has(name);
      named.add(name);
      const switched = first && this.#enabled.has(name);
      const edited = first && this.#configuration.has(name);
      if (switched) count += 1;
      if (edited) count += 1;
      if (!switched && !edited && plugin.restartRequired) count += 1;
    }
    return count;
  }

  /** The writes that apply every draft, one per changed plugin, in the host's order. */
  writes(snapshot: PluginsSnapshot): readonly PluginWrite[] {
    const writes: PluginWrite[] = [];
    const named = new Set<string>();
    for (const plugin of snapshot.plugins) {
      const name = plugin.descriptor.name;
      if (named.has(name)) continue;
      named.add(name);
      const enabled = this.#enabled.get(name);
      const text = this.#configuration.get(name);
      const parsed = text === undefined ? undefined : parseConfiguration(text);
      const configuration = parsed !== undefined && 'value' in parsed ? parsed.value : undefined;
      if (enabled === undefined && configuration === undefined) continue;
      writes.push({
        name,
        ...(enabled === undefined ? {} : { enabled }),
        ...(configuration === undefined ? {} : { configuration }),
      });
    }
    return writes;
  }
}
