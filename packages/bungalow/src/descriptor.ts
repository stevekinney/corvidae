import { resolveRemoteDescriptor, type RemoteBungalowDescriptor } from './remote-configuration.ts';
import { resolveBungalowRoot, type BungalowEnvironment } from './resolve-root.ts';
import { assertBungalowName } from './validation.ts';

/** A home that is a directory on this machine, opened with `openLocalBungalow`. */
export type LocalBungalowDescriptor = {
  /** Selects local mode. */
  readonly kind: 'local';
  /** The home's absolute, normalized root directory. */
  readonly root: string;
};

/** Where an application's home is: a local root, or the validated settings of a remote one. */
export type BungalowDescriptor = LocalBungalowDescriptor | RemoteBungalowDescriptor;

/** What `resolveBungalowDescriptor` reads. Every input is explicit; nothing defaults to the process. */
export type ResolveBungalowDescriptorOptions = {
  /** The application name, such as `interborough`. */
  readonly name: string;
  /** The environment to read the `<NAME>_` and `S3_` variables from. */
  readonly environment: BungalowEnvironment;
  /** The directory a default local root lives under, normally the user's home directory. */
  readonly homeDirectory: string;
};

/**
 * Decide where the application's home is, from an environment, without opening it. Pure: it
 * performs no I/O, takes no lock, and reads no process state, so the environment and the home
 * directory are both required.
 *
 * With both `<NAME>_DATABASE_URL` and `<NAME>_BUCKET` set, the result is a validated
 * `{ kind: 'remote', ... }` descriptor (see `RemoteBungalowDescriptor`), and `<NAME>_HOME` is not
 * read. With exactly one set, a required `S3_` variable missing (the first in the order
 * `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`), a bucket that is not
 * path-safe, or a prefix with an empty, `.`, or `..` segment or a backslash, this throws
 * `BungalowInputError` naming the variable. Otherwise the result is `{ kind: 'local', root }` with
 * the root `resolveBungalowRoot` gives: `<NAME>_HOME`, or `<homeDirectory>/.<name>`.
 */
export function resolveBungalowDescriptor(
  options: ResolveBungalowDescriptorOptions,
): BungalowDescriptor {
  assertBungalowName(options.name);
  return (
    resolveRemoteDescriptor(options.name, options.environment) ?? {
      kind: 'local',
      root: resolveBungalowRoot(options),
    }
  );
}
