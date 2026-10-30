/**
 * The error a configuration that cannot be used throws, in a module of its own so the parts of the
 * configuration (`providers.ts`, `catalog-edits.ts`) share it without importing each other.
 *
 * @module provider-configuration-error
 */

/** A configuration that cannot be used. The message names the file and the field, never a value. */
export class ProviderConfigurationError extends Error {
  /** Where the configuration lives (a path or an `s3://` location). */
  readonly path: string;
  /** The field that cannot be used, such as `providers.openai.models[1]`. */
  readonly field: string;

  constructor(path: string, field: string, problem: string) {
    super(`Invalid configuration in ${path}, ${field}: ${problem}`);
    this.name = 'ProviderConfigurationError';
    this.path = path;
    this.field = field;
  }
}
