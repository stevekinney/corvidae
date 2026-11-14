import { BungalowInputError } from './errors.ts';

/** Bootstrap inputs never resolve through an injected managed-secret provider. */
export type DeploymentSecrets = {
  /** Read a validated deployment key; backend failure is distinct from absence. */
  read(key: string): Promise<string | undefined>;
  /** Store a local deployment input; environment-backed inputs are read-only. */
  write(key: string, value: string): Promise<void>;
  /** Operator-facing location without a credential value. */
  location(key: string): string;
};

/** What a `DeploymentSecretsFactory` receives once the home's identity is bound. */
export type DeploymentSecretsContext = {
  /** The workspace identity the home is bound to. */
  readonly workspaceId: string;
  /** Throws `BungalowStateError` once the handle is closed; call it before every use. */
  readonly assertOpen: () => void;
};

/**
 * Trusted composition supplies the home's deployment secrets, such as an operating-system keychain
 * in a desktop host. It is called once per open, after the workspace identity is bound and before
 * the caller gets the handle. It replaces only `Bungalow.deploymentSecrets`: the managed
 * `secretProvider` is chosen separately, and neither routes through the other.
 */
export type DeploymentSecretsFactory = (context: DeploymentSecretsContext) => DeploymentSecrets;

/** The secrets an injected factory returns, refused unless they can be read, written, and located. */
export function injectedDeploymentSecrets(
  factory: DeploymentSecretsFactory,
  context: DeploymentSecretsContext,
): DeploymentSecrets {
  const secrets: unknown = factory(context);
  if (
    typeof secrets !== 'object' ||
    secrets === null ||
    !('read' in secrets) ||
    typeof secrets.read !== 'function' ||
    !('write' in secrets) ||
    typeof secrets.write !== 'function' ||
    !('location' in secrets) ||
    typeof secrets.location !== 'function'
  ) {
    throw new BungalowInputError(
      'The injected deployment secrets must have read, write, and location functions.',
    );
  }
  return secrets as DeploymentSecrets;
}
