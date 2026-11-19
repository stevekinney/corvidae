import type { Storage } from '@lostgradient/storage';
import type { ToolPolicyHooks } from 'armorer';
import type { z } from 'zod';

import type { PluginSetupResult } from './contributions.ts';
import type { PluginHost } from './host-api.ts';

/** A secret a plugin declares: the full Bungalow secret key, or the key with how it is created. */
export type PluginSecretDeclaration =
  | string
  | {
      /** The full Bungalow secret key, such as `example-api-key`. */
      readonly key: string;
      /** Whether the host creates a random value on first enable, instead of the owner entering one. */
      readonly generated?: boolean;
    };

/** Reads the secrets a plugin declared. A value is read when asked for, so a saved secret is seen without a restart. */
export interface PluginSecrets {
  /** The secret's value, or `undefined` when it is not set. */
  get(key: string): Promise<string | undefined>;
}

/** What `setup`, and `start` beside the host API, receive. */
export interface PluginSetupContext<TConfiguration = unknown> {
  /** The plugin's configuration, parsed with its `configuration` schema. */
  readonly configuration: TConfiguration;
  /** The secrets the plugin declared. */
  readonly secrets: PluginSecrets;
  /** Storage confined to the key prefix `plugin:<name>:`. */
  readonly storage: Storage;
  /**
   * The host API, the same one `start` receives, for a contribution to call while it runs.
   * What it causes is the plugin's: a schedule it creates announces `schedule.created`, and a goal
   * it creates announces every `goal.*` event, with `source` naming the plugin. A call made before
   * the host has started, from `setup` itself, rejects.
   */
  readonly host: PluginHost;
  /**
   * The host's tool-approval rule as a policy hook, for the toolbox a plugin builds for one of its
   * code agents: pass it as the toolbox's `policy`. A tool of `tools` that only reads runs, and one
   * that changes something waits for an operator, unless the chat's permission mode says
   * otherwise: `read-only` denies it, `allow-all` lets it run, and `always` asks about every call.
   * It governs only the tools named in `tools`, because the host adds its own tools to a run's
   * toolbox, and those take the host's rule instead.
   */
  readonly approvals: (tools: readonly string[]) => ToolPolicyHooks;
}

/**
 * A hook a plugin declares as a default (COR-2180): one the host makes for the owner when the plugin
 * runs, and reconciles with this list at each start. The owner can turn it off and copy it, and can
 * change nothing else about it.
 */
export interface PluginHook {
  /**
   * The hook's label and the key it is reconciled by, 1 to 100 characters and unique among the
   * plugin's hooks. Renaming a hook withdraws the old one and makes a new one.
   */
  readonly name: string;
  /**
   * The event kinds the hook fires on: kinds of Bureau's event catalog (`PUBLISHED_BUREAU_EVENT_KINDS`,
   * such as `run.settled`), and `<plugin>:<name>` kinds another running plugin declares. The hook
   * is pinned to a declared kind's version each time it is reconciled, so it follows the declaring
   * plugin's upgrades. A kind no running plugin declares, or one this plugin declares itself (its
   * reaction never runs on its own plugin's events, so the hook could never fire), skips the hook
   * with a `hook-invalid` problem at `events`.
   */
  readonly events: readonly string[];
  /** The name of one of this plugin's `reactions`: what the hook does. */
  readonly reaction: string;
  /** The reaction's configuration, checked against the schema the reaction declares. */
  readonly configuration?: unknown;
  /** The one subject the hook fires for; every kind in `events` must be one an event can be told by. Omitted, it fires for the whole Bureau. */
  readonly scope?: {
    /** What `id` names. */
    readonly kind: 'agent' | 'workflow' | 'schedule';
    /** The agent's name, the workflow's identifier, or the schedule's id. */
    readonly id: string;
  };
}

/** The schema a plugin without a `configuration` declares: an object with no members. */
export type PluginEmptyConfigurationSchema = z.ZodType<Record<string, never>>;

/** What a plugin declares. */
export interface PluginDescriptor<
  TConfigurationSchema extends z.ZodType = PluginEmptyConfigurationSchema,
> {
  /** The plugin's name; it matches `pluginNamePattern`, and prefixes every contribution's id. */
  readonly name: string;
  /**
   * The plugin's name as a person reads it, such as `Web search` or `OpenAI`. Settings shows it,
   * with `name` small beside it. Defaults to `name`.
   */
  readonly title?: string;
  /** The plugin's version; a durable record pins it when a contribution declares no version of its own. */
  readonly version: string;
  /** What the plugin does, as Settings shows it. */
  readonly description: string;
  /** Whether the owner cannot disable the plugin. */
  readonly required?: boolean;
  /** Whether the plugin runs before the owner has chosen. Defaults to `true`. */
  readonly enabled?: boolean;
  /** The schema of the plugin's configuration. */
  readonly configuration?: TConfigurationSchema;
  /** The secrets the plugin needs. */
  readonly secrets?: readonly PluginSecretDeclaration[];
  /** The directory of agent, workflow and skill files the plugin ships. */
  readonly content?: URL;
  /**
   * Hooks the plugin makes for its owner (COR-2180): default hooks that run one of its `reactions`.
   * A hook that names a reaction the plugin does not contribute, lists an event kind that is not
   * published, or repeats a name is skipped alone, with a `hook-invalid` problem naming it; the
   * plugin's other contributions still load. A plugin that is disabled leaves its hooks as they are
   * (they run nothing), and one the host no longer knows has its hooks withdrawn, never deleted.
   */
  readonly hooks?: readonly PluginHook[];
  /** Builds the plugin's contributions once at startup. */
  setup?(
    context: PluginSetupContext<z.output<TConfigurationSchema>>,
  ):
    | PluginSetupResult<z.output<TConfigurationSchema>>
    | Promise<PluginSetupResult<z.output<TConfigurationSchema>>>;
}
