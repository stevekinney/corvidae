import type { Storage } from '@lostgradient/storage';
import type { z } from 'zod';

import type { PluginSetupResult } from './contributions.ts';

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
