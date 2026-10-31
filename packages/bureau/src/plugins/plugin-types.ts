/**
 * COR-1879 — the plugin options of `createBureau` and the shapes `bureau.plugins.list()` reports.
 *
 * @module plugin-types
 */

import type { ContributedEmbedder, GovernedMemory } from '@lostgradient/memory';
import type { BackendDescriptor, ProviderDefinition } from '@lostgradient/operative/provider-kit';
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
  /**
   * Set by a host that loads the plugin from a source tree it is developing (COR-1881): the
   * folder's absolute path. The listing then carries a `development-source` problem; the plugin's
   * status is whatever its own standing is.
   */
  readonly developmentPath?: string;
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

/** One model provider a running plugin contributed, with the catalog rows of its models. */
export interface PluginProviderContribution {
  /** The plugin that contributed it. */
  readonly plugin: string;
  /** The provider definition the host resolves a generate through. */
  readonly definition: ProviderDefinition;
  /** The catalog rows of its models; each row's `provider` is `definition.name`. */
  readonly rows: readonly BackendDescriptor[];
}

/** What plugins contribute to the model catalog, for a `models.catalog` factory to build rows from. */
export interface PluginModelContributions {
  /** Every provider contributed by a `running` or `needs-setup` plugin, in load order. */
  readonly providers: readonly PluginProviderContribution[];
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
      /**
       * A secret the plugin declared is not set. The plugin is `needs-setup`: its contributions are
       * registered but refuse to run until the secret is saved, which needs no restart.
       */
      readonly code: 'secret-missing';
      /** The declared secret key. */
      readonly key: string;
      /**
       * The contributions that wait for it, by their listed ids: every one the plugin registered,
       * because a secret declaration does not say which contribution uses it.
       */
      readonly contributions: readonly string[];
    }
  | {
      /**
       * A file the plugin ships names a contribution that is not loaded. The file is `invalid`;
       * the plugin keeps `running`.
       */
      readonly code: 'reference-unresolved';
      /** The file, by the identifier the catalog lists it under (`plugin:name`). */
      readonly file: string;
      /** The id the file names that nothing loaded holds. */
      readonly id: string;
    }
  | {
      /**
       * Work recorded against a version of one of the plugin's contributions that is not loaded
       * was found when this Bureau started. It is never resumed on another version: a pending tool
       * approval is dropped, and a workflow instance is cancelled with `unresumable`.
       */
      readonly code: 'pinned-version-unavailable';
      /** The contribution, `plugin:name`, without a version. */
      readonly id: string;
      /** The version the work recorded. */
      readonly version: string;
      /** How many runs waited on that version. */
      readonly waitingRuns: number;
    }
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
      /**
       * The host loaded this plugin from a source tree under development, not from an installed
       * package or Bungalow's `plugins/` folder (COR-1881). The plugin runs; the problem tells the
       * owner it is a work in progress. Set by the host, never by composition.
       */
      readonly code: 'development-source';
      /** The folder the plugin was loaded from. */
      readonly path: string;
    }
  | {
      /**
       * The host refused to load the plugin because it declares a secret it cannot honor: a key the
       * host keeps for itself, or one Bungalow cannot store. The plugin is `skipped` and the host
       * starts (COR-1881). Set by the host, never by composition.
       */
      readonly code: 'secret-refused';
      /** The declared key. */
      readonly key: string;
      /** Why it is refused, naming the key and never a value. */
      readonly message: string;
    }
  | {
      /**
       * The host could not load the plugin's code from its folder, such as an import of a package
       * that is not installed (the message names the specifier) or a `plugin.ts` with no plugin as
       * its default export. The plugin is `skipped` and the host starts (COR-1881). Set by the
       * host, never by composition.
       */
      readonly code: 'load-failed';
      /** The failure's message, naming the folder and, for a failed import, the specifier. */
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

/** One contribution a running plugin registered, as composition records it. */
export interface PluginContribution {
  /** Its kind. */
  readonly kind: PluginContributionKind;
  /** `plugin:name`, as a file names it; a tool's id carries its version, `plugin:name@version`. */
  readonly id: string;
}

/**
 * What names one contribution now, counted afresh on every `plugins.list()`. A tool is matched
 * without its version, since a file names `plugin:name`.
 */
export interface PluginContributionReferences {
  /**
   * The ready agents whose definition names it: a tool in a file's or a code agent's `tools`, a
   * guardrail in a file's `guardrails`, a run hook set in a file's `hooks`. No other kind is named
   * by an agent, so it counts none.
   */
  readonly agents: number;
  /**
   * The agent schedules, paused or active, whose agent is this contribution (a code agent) or one
   * of the agents counted in `agents`. None without a durable engine.
   */
  readonly schedules: number;
  /**
   * The runs with a pending review (`bureau.reviews.list()`) that is an approval of this tool, or
   * whose agent is this contribution (a code agent) or one of the agents counted in `agents`.
   */
  readonly waitingRuns: number;
}

/** One contribution a running plugin registered, with what names it now. */
export interface PluginContributionListing extends PluginContribution {
  /** What names it now. */
  readonly references: PluginContributionReferences;
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
   * What it registered; empty unless it is `running` or `needs-setup`. A contribution whose option the host did not
   * give (`hooks` for a hook action kind, `onlineEvals` for an eval judge, a `memory` factory for an
   * embedder or memory detector) is not registered, and is not listed.
   */
  readonly contributions: readonly PluginContributionListing[];
}

/** `bureau.plugins`: the plugins the Bureau was given, in load order. */
export interface BureauPlugins {
  /**
   * Every plugin, in load order, as it stands now. Each contribution's `references` are counted
   * on every call from the agents, schedules and pending reviews as they stand, never cached.
   */
  list(): Promise<readonly PluginListing[]>;
  /**
   * The names of the plugins whose contributions are registered (`running` or `needs-setup` in
   * the listing), in load order. Fixed once the Bureau is built, and read without counting
   * anything, for a caller that needs only the names.
   */
  registered(): readonly string[];
  /** Settles once every running plugin's `afterStart` has settled. Never rejects. */
  ready(): Promise<void>;
}
