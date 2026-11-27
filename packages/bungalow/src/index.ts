export { createSigV4Presigner } from '@lostgradient/object-store';
export type {
  ObjectPresigner,
  ObjectStoreOperations,
  PresignMethod,
  PresignOptions,
  S3ObjectStoreOperations,
  SigV4PresignerOptions,
} from '@lostgradient/object-store';
export { openBindingBungalow } from './binding.ts';
export { openBungalow, openLocalBungalow, openTemporaryBungalow } from './bungalow.ts';
export type {
  AcquireLock,
  Bungalow,
  ContentLocation,
  D1DatabaseBinding,
  DatabaseLocation,
  DatabaseWorkspaceClaim,
  OpenBindingBungalowOptions,
  OpenBungalowOptions,
  OpenLocalBungalowOptions,
  OpenRemoteBungalowOptions,
  OpenTemporaryBungalowOptions,
  PresignerFactory,
  SecretProviderFactory,
} from './bungalow.ts';
export type {
  DeploymentSecrets,
  DeploymentSecretsContext,
  DeploymentSecretsFactory,
} from './deployment-secrets.ts';
export { resolveBungalowDescriptor, resolveWorkerBungalowDescriptor } from './descriptor.ts';
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
export { acquireLocalRootLockDescriptor, acquirePortableLock } from './lock.ts';
export type { RootLock } from './lock.ts';
export type { BungalowObjectStore } from './object-store.ts';
export type {
  BindingBungalowDescriptor,
  RemoteBungalowDescriptor,
  WorkerBungalowEnvironment,
} from './remote-configuration.ts';
export { defaultPresigner, openRemoteBungalow } from './remote.ts';
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
