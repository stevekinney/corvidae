/**
 * The grammar of a plugin name and of a contribution name: a leading letter, then lowercase
 * letters, digits and hyphens, ending in a letter or digit. The leading letter keeps the Weft
 * handler name `plugin__name` inside Weft's own name grammar.
 */
export const pluginNamePattern = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;

/** Whether `value` is a well-formed plugin or contribution name. */
export function isPluginName(value: unknown): value is string {
  return typeof value === 'string' && pluginNamePattern.test(value);
}
