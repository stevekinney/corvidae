export { openBungalow, openLocalBungalow, openTemporaryBungalow } from './bungalow.ts';
export type {
  Bungalow,
  ContentLocation,
  DatabaseLocation,
  DatabaseWorkspaceClaim,
  OpenBungalowOptions,
  OpenLocalBungalowOptions,
  OpenRemoteBungalowOptions,
  OpenTemporaryBungalowOptions,
  SecretProviderFactory,
} from './bungalow.ts';
export type {
  DeploymentSecrets,
  DeploymentSecretsContext,
  DeploymentSecretsFactory,
} from './deployment-secrets.ts';
export { resolveBungalowDescriptor } from './descriptor.ts';
export type {
  BungalowDescriptor,
  LocalBungalowDescriptor,
  ResolveBungalowDescriptorOptions,
} from './descriptor.ts';
export {
  BungalowError,
  BungalowFilesystemError,
  BungalowInputError,
  BungalowLockedError,
  BungalowStateError,
  BungalowUnsupportedError,
} from './errors.ts';
export type { RootLock } from './lock.ts';
export type { RemoteBungalowDescriptor } from './remote-configuration.ts';
export { openRemoteBungalow } from './remote.ts';
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
