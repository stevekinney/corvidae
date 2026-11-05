export { openBungalow, openTemporaryBungalow } from './bungalow.ts';
export type {
  Bungalow,
  ContentLocation,
  DatabaseLocation,
  DatabaseWorkspaceClaim,
  DeploymentSecrets,
  OpenBungalowOptions,
  OpenTemporaryBungalowOptions,
  SecretProviderFactory,
} from './bungalow.ts';
export {
  BungalowError,
  BungalowFilesystemError,
  BungalowInputError,
  BungalowLockedError,
  BungalowStateError,
  BungalowUnsupportedError,
} from './errors.ts';
export { bungalowHomeVariable, resolveBungalowRoot } from './resolve-root.ts';
export type { BungalowEnvironment, ResolveBungalowRootOptions } from './resolve-root.ts';

export {
  SecretProviderError,
  createLocalSecretProvider,
  parseSecretReference,
} from './secret-provider.ts';
export type {
  LocalSecretProviderOptions,
  PrepareSecretInput,
  SecretOperationMetadata,
  SecretOperationState,
  SecretOperationTransition,
  SecretProvider,
  SecretProviderCapabilities,
  SecretProviderErrorCode,
  SecretReference,
} from './secret-provider.ts';

export type {
  ConfigurationSnapshot,
  ConfigurationWriteCapability,
  ConfigurationWriteCondition,
  ConfigurationWriteResult,
} from './configuration.ts';

export { createEnvironmentSecretProvider } from './environment-secret-provider.ts';
export type { EnvironmentSecretProviderOptions } from './environment-secret-provider.ts';
