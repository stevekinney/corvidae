import { isAbsolute, join } from 'node:path';

import { BungalowInputError } from './errors.ts';
import { assertBungalowName } from './validation.ts';

export type BungalowEnvironment = Readonly<Record<string, string | undefined>>;

export type ResolveBungalowRootOptions = {
  /** The application name, such as `interborough`. */
  readonly name: string;
  /** The environment to read `<NAME>_HOME` from. */
  readonly environment: BungalowEnvironment;
  /** The directory a default root lives under, normally the user's home directory. */
  readonly homeDirectory: string;
};

/** The environment variable that overrides the root: `interborough` reads `INTERBOROUGH_HOME`. */
export function bungalowHomeVariable(name: string): string {
  assertBungalowName(name);
  return `${name.toUpperCase().replaceAll('-', '_')}_HOME`;
}

function requireAbsolute(path: string, description: string): string {
  if (!isAbsolute(path)) {
    throw new BungalowInputError(`${description} must be an absolute path.`);
  }
  return path;
}

/**
 * Where an application's state lives: `<NAME>_HOME` when that variable is set and non-empty,
 * otherwise `<homeDirectory>/.<name>`. Pure: it creates, reads, and locks nothing. A relative
 * path is rejected, because a state directory that moves with the working directory loses data.
 */
export function resolveBungalowRoot(options: ResolveBungalowRootOptions): string {
  const variable = bungalowHomeVariable(options.name);
  const override = options.environment[variable];
  if (override !== undefined && override !== '') {
    return requireAbsolute(override, variable);
  }
  return join(requireAbsolute(options.homeDirectory, 'The home directory'), `.${options.name}`);
}
