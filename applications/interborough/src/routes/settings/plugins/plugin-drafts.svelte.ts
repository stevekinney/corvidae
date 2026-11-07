/**
 * The switches Settings › Plugins holds before they are applied: which plugins are switched on or
 * off. Nothing here reaches the host. A choice is kept only while it differs from what the host has
 * stored, so putting a switch back leaves nothing pending. Applying them is one step with the
 * restart (`restart-flow.svelte.ts`): each switched plugin is written with
 * `PUT /host/plugins/<name>`, then the host restarts.
 *
 * A plugin's configuration is not a draft: it is saved by its own explicit Save
 * (`plugin-configuration.svelte`), which stores it and waits for a restart like any change that
 * `restartRequired` reports.
 */
import { SvelteMap } from 'svelte/reactivity';

import type { PluginStanding, PluginsSnapshot } from '../../../lib/host-plugins.ts';

/** One plugin's write: the switch a person changed. */
export type PluginWrite = {
  readonly name: string;
  readonly enabled: boolean;
};

/** The drafts of one page. */
export class PluginDrafts {
  readonly #enabled = new SvelteMap<string, boolean>();

  /** Whether the plugin is switched on in the page: the draft, or what the host has stored. */
  enabledOf(plugin: PluginStanding): boolean {
    return this.#enabled.get(plugin.descriptor.name) ?? plugin.enabled;
  }

  /** Switches a plugin on or off. Putting it back to what is stored removes the draft. */
  setEnabled(plugin: PluginStanding, enabled: boolean): void {
    const name = plugin.descriptor.name;
    if (enabled === plugin.enabled) this.#enabled.delete(name);
    else this.#enabled.set(name, enabled);
  }

  /** Whether the page holds a choice the host does not have yet. */
  get hasDrafts(): boolean {
    return this.#enabled.size > 0;
  }

  /**
   * Drops the drafts the host now holds as stored choices, which is what is left of a write that
   * reached some plugins before it failed, or a change made somewhere else in the meantime.
   */
  reconcile(snapshot: PluginsSnapshot): void {
    for (const plugin of snapshot.plugins) {
      const name = plugin.descriptor.name;
      if (this.#enabled.get(name) === plugin.enabled) this.#enabled.delete(name);
    }
  }

  /** Drops every draft. */
  discard(): void {
    this.#enabled.clear();
  }

  /**
   * The plugins that wait for a restart: each one the page holds a switch for, and each one whose
   * stored choices the host already reports as not loaded yet (a saved configuration, say). The
   * host stores choices by name, and they belong to the first plugin with it.
   */
  changed(snapshot: PluginsSnapshot): readonly PluginStanding[] {
    const named = new Set<string>();
    const changed: PluginStanding[] = [];
    for (const plugin of snapshot.plugins) {
      const name = plugin.descriptor.name;
      const first = !named.has(name);
      named.add(name);
      if (first && (this.#enabled.has(name) || plugin.restartRequired)) changed.push(plugin);
    }
    return changed;
  }

  /**
   * The switches a restart writes, by plugin, in the host's order. The dialog that disables one
   * plugin lists these for the others.
   */
  pendingWrites(snapshot: PluginsSnapshot): readonly PluginWrite[] {
    const writes: PluginWrite[] = [];
    const named = new Set<string>();
    for (const plugin of snapshot.plugins) {
      const name = plugin.descriptor.name;
      if (named.has(name)) continue;
      named.add(name);
      const enabled = this.#enabled.get(name);
      if (enabled !== undefined) writes.push({ name, enabled });
    }
    return writes;
  }
}
