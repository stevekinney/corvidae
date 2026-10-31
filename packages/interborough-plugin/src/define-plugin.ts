import type { z } from 'zod';

import type {
  PluginDescriptor,
  PluginEmptyConfigurationSchema,
  PluginSecretDeclaration,
} from './plugin-descriptor.ts';
import { isPluginName } from './plugin-name.ts';

function secretKey(declaration: PluginSecretDeclaration): string {
  return typeof declaration === 'string' ? declaration : declaration.key;
}

/**
 * Declares a plugin. It returns the descriptor unchanged, typed so `setup` and `afterStart` see the
 * configuration the `configuration` schema parses to, and refuses a malformed descriptor where the
 * plugin is written instead of where the host loads it: a name outside `pluginNamePattern`, an
 * empty version or description, or a secret that is empty or declared twice.
 */
export function definePlugin<
  TConfigurationSchema extends z.ZodType = PluginEmptyConfigurationSchema,
>(descriptor: PluginDescriptor<TConfigurationSchema>): PluginDescriptor<TConfigurationSchema> {
  if (!isPluginName(descriptor.name)) {
    throw new TypeError(
      `Plugin name ${JSON.stringify(descriptor.name)} must start with a lowercase letter and use only lowercase letters, digits and hyphens, ending in a letter or digit.`,
    );
  }
  if (typeof descriptor.version !== 'string' || descriptor.version.trim() === '') {
    throw new TypeError(`Plugin "${descriptor.name}" must declare a non-empty version.`);
  }
  if (typeof descriptor.description !== 'string' || descriptor.description.trim() === '') {
    throw new TypeError(`Plugin "${descriptor.name}" must declare a non-empty description.`);
  }
  const keys = new Set<string>();
  for (const declaration of descriptor.secrets ?? []) {
    const key = secretKey(declaration);
    if (typeof key !== 'string' || key.trim() === '') {
      throw new TypeError(`Plugin "${descriptor.name}" declares a secret with an empty key.`);
    }
    if (keys.has(key)) {
      throw new TypeError(`Plugin "${descriptor.name}" declares the secret "${key}" twice.`);
    }
    keys.add(key);
  }
  return descriptor;
}
