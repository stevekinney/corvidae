/**
 * COR-1879 — the plugin options of `createBureau` and the shapes `bureau.plugins.list()` reports.
 *
 * @module plugin-types
 */

import type { ContributedEmbedder, GovernedMemory } from '@lostgradient/memory';
import type { PluginDescriptor } from '@lostgradient/interborough-plugin';
import type { InputDetector } from 'armorer';
import type { z } from 'zod';

/** Where a plugin was loaded from: a workspace package the host lists, or Bungalow's `plugins/` folder. */
export type PluginLoadSource = 'package' | 'folder';

/** One plugin the host offers `createBureau`. */
export interface BureauPluginEntry {
  /** The plugin's descriptor, as `definePlugin` returned it. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each plugin declares its own configuration schema.
  readonly descriptor: PluginDescriptor<z.ZodType<any>>;
  /** Where it was loaded from. Package plugins load first, in the order given, then folder plugins by folder name. */
  readonly source: PluginLoadSource;
  /** The package name, or the plugin's folder; a folder plugin's last path segment orders it. */
  readonly location: string;
}

/** The owner's choices for one plugin, persisted under `plugins.<name>` in Bungalow's configuration. */
export interface BureauPluginSettings {
  /** Whether the plugin runs; absent takes the descriptor's `enabledByDefault`, itself `true` by default. */
  readonly enabled?: boolean | undefined;
  /** The value the plugin's `configuration` schema parses; absent parses `{}`. */
  readonly configuration?: unknown;
}

/** Reads the deployment's secrets. Values are read when asked for, never held. */
export interface BureauPluginSecrets {
  /** The secret's value, or `undefined` when it is not set. */
  get(key: string): Promise<string | undefined>;
  /** Calls `listener` whenever `key` is saved or removed; returns the function that stops it. */
  watch(key: string, listener: () => void): () => void;
}

/** What plugins contribute to governed memory, for a `memory` factory to build with. */
export interface PluginMemoryContributions {
  /** Detectors run after the default poisoning detector, on admission and on recall. */
  readonly detectors: readonly InputDetector[];
  /** Embedders a `memory.embedder` setting can name, by `plugin:name`. */
  readonly embedders: readonly ContributedEmbedder[];
}

/** Builds governed memory once plugin setup has run, with what the plugins contribute to it. */
export type BureauMemoryFactory = (contributions: PluginMemoryContributions) => GovernedMemory;

/** What a plugin is now. */
export type PluginStatus = 'running' | 'needs-setup' | 'disabled' | 'skipped';

/** One side of a name clash: who holds, or wanted, the name. `built-in` is anything that is not a plugin. */
export interface PluginClashParty {
  /** `package` or `folder` for a plugin, `built-in` for a name the host's own options hold. */
  readonly source: PluginLoadSource | 'built-in';
  /** The plugin's package or folder, or `host` for a name the host's own options hold. */
  readonly location: string;
}

/** Something wrong with a plugin, by `code`. */
export type PluginProblem =
  | {
      /** The configuration does not parse; the plugin is `skipped` and the host starts. */
      readonly code: 'configuration-invalid';
      /** The dotted path of the field the schema refused; empty for the configuration as a whole. */
      readonly field: string;
      /** The schema's message. */
      readonly message: string;
    }
  | {
      /** A name the plugin claims is already held; the first holder keeps it and this plugin is `skipped`. */
      readonly code: 'name-clash';
      /** The plugin name, contribution id (`plugin:name`) or event kind both claim. */
      readonly name: string;
      /** Who holds it. */
      readonly first: PluginClashParty;
      /** Who was refused it. */
      readonly second: PluginClashParty;
    }
  | {
      /**
       * `setup` threw or rejected, or returned a contribution that cannot be registered (a name
       * outside the plugin name grammar, a tool that cannot be rebuilt, an embedder without a
       * positive integer dimension); the plugin is `skipped` and the host starts.
       */
      readonly code: 'setup-failed';
      /** The error's message, with every secret value the plugin was handed removed. */
      readonly message: string;
    }
  | {
      /** `afterStart` threw or rejected; the plugin's contributions stay registered. */
      readonly code: 'after-start-failed';
      /** The error's message, with every secret value the plugin was handed removed. */
      readonly message: string;
    };

/** A kind of contribution, as the listing names it. */
export type PluginContributionKind =
  | 'tool'
  | 'activity'
  | 'trigger-kind'
  | 'validator'
  | 'guardrail'
  | 'run-hooks'
  | 'decision-router'
  | 'hook-action'
  | 'provider'
  | 'embedder'
  | 'memory-detector'
  | 'eval-judge'
  | 'mcp-app'
  | 'event-formatter'
  | 'code-agent';

/** One contribution a running plugin registered. */
export interface PluginContributionListing {
  /** Its kind. */
  readonly kind: PluginContributionKind;
  /** `plugin:name`, as a file names it; a tool's id carries its version, `plugin:name@version`. */
  readonly id: string;
}

/** What `plugins.list()` reports of a descriptor: never its schema, its functions or a secret's value. */
export interface PluginDescriptorListing {
  /** The plugin's name. */
  readonly name: string;
  /** The plugin's version. */
  readonly version: string;
  /** What the plugin does. */
  readonly description: string;
  /** Whether the owner cannot disable it. */
  readonly required: boolean;
  /** Whether it runs before the owner has chosen. */
  readonly enabledByDefault: boolean;
  /** The secret keys it declares, and whether the host generates each. */
  readonly secrets: readonly { readonly key: string; readonly generated: boolean }[];
}

/** One plugin as `plugins.list()` reports it. */
export interface PluginListing {
  /** Its descriptor. */
  readonly descriptor: PluginDescriptorListing;
  /** Where it was loaded from. */
  readonly source: PluginLoadSource;
  /** Its package or folder. */
  readonly location: string;
  /** What it is now. */
  readonly status: PluginStatus;
  /** What is wrong with it, empty when nothing is. */
  readonly problems: readonly PluginProblem[];
  /**
   * What it registered; empty unless it is `running`. A contribution whose option the host did not
   * give (`hooks` for a hook action kind, `onlineEvals` for an eval judge, a `memory` factory for an
   * embedder or memory detector) is not registered, and is not listed.
   */
  readonly contributions: readonly PluginContributionListing[];
}

/** `bureau.plugins`: the plugins the Bureau was given, in load order. */
export interface BureauPlugins {
  /** Every plugin, in load order, as it stands now. */
  list(): readonly PluginListing[];
  /** Settles once every running plugin's `afterStart` has settled. Never rejects. */
  ready(): Promise<void>;
}
