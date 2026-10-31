import type { Storage } from '@lostgradient/storage';
import type { ToolPolicyHooks } from 'armorer';
import type { z } from 'zod';

import type { PluginSetupResult } from './contributions.ts';
import type { PluginHostApi } from './host-api.ts';

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

/** What `setup`, and `afterStart` beside the host API, receive. */
export interface PluginSetupContext<TConfiguration = unknown> {
  /** The plugin's configuration, parsed with its `configuration` schema. */
  readonly configuration: TConfiguration;
  /** The secrets the plugin declared. */
  readonly secrets: PluginSecrets;
  /** Storage confined to the key prefix `plugin:<name>:`. */
  readonly storage: Storage;
  /**
   * The host API, the same one `afterStart` receives, for a contribution to call while it runs.
   * What it causes is the plugin's: a schedule it creates announces `schedule.created`, and a goal
   * it creates announces every `goal.*` event, with `source` naming the plugin. A call made before
   * the host has started, from `setup` itself, rejects.
   */
  readonly host: PluginHostApi;
  /**
   * The host's tool-approval rule as a policy hook, for the toolbox a plugin builds for one of its
   * code agents: pass it as the toolbox's `policy`. A tool of `tools` that only reads runs, and one
   * that changes something waits for an operator, unless the chat's permission mode says
   * otherwise: `read-only` denies it, `allow-all` lets it run, and `always` asks about every call.
   * It governs only the tools named in `tools`, because the host adds its own tools to a run's
   * toolbox, and those take the host's rule instead.
   */
  readonly toolApprovalHooks: (tools: readonly string[]) => ToolPolicyHooks;
}

/** The schema a plugin without a `configuration` declares: an object with no members. */
export type PluginEmptyConfigurationSchema = z.ZodType<Record<string, never>>;

/** What a plugin declares. */
export interface PluginDescriptor<
  TConfigurationSchema extends z.ZodType = PluginEmptyConfigurationSchema,
> {
  /** The plugin's name; it matches `pluginNamePattern`, and prefixes every contribution's id. */
  readonly name: string;
  /** The plugin's version; a durable record pins it when a contribution declares no version of its own. */
  readonly version: string;
  /** What the plugin does, as Settings shows it. */
  readonly description: string;
  /** Whether the owner cannot disable the plugin. */
  readonly required?: boolean;
  /** Whether the plugin runs before the owner has chosen. Defaults to `true`. */
  readonly enabledByDefault?: boolean;
  /** The schema of the plugin's configuration. */
  readonly configuration?: TConfigurationSchema;
  /** The secrets the plugin needs. */
  readonly secrets?: readonly PluginSecretDeclaration[];
  /** The directory of agent, workflow and skill files the plugin ships. */
  readonly content?: URL;
  /** Builds the plugin's contributions once at startup. */
  setup?(
    context: PluginSetupContext<z.output<TConfigurationSchema>>,
  ):
    | PluginSetupResult<z.output<TConfigurationSchema>>
    | Promise<PluginSetupResult<z.output<TConfigurationSchema>>>;
}
