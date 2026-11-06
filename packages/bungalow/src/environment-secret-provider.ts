import { assertWorkspace, SecretProviderError, type SecretProvider } from './secret-provider.ts';
import { assertSecretKey } from './validation.ts';

/** Construction inputs for a captured read-only environment provider. */
export type EnvironmentSecretProviderOptions = Readonly<{
  workspaceId: string;
  values: Readonly<Record<string, string | undefined>>;
  assertOpen?: () => void;
}>;
/** Create a read-only provider backed by captured deployment values. */
export function createEnvironmentSecretProvider(
  options: EnvironmentSecretProviderOptions,
): SecretProvider {
  const workspaceId = options.workspaceId;
  assertWorkspace(workspaceId);
  const assertOpen = options.assertOpen ?? (() => undefined);
  const values = { ...options.values };
  return {
    workspaceId: workspaceId,
    capabilities: { read: true, prepare: false, transitions: false },
    async readLegacy(key) {
      assertOpen();
      assertSecretKey(key);
      return Object.hasOwn(values, key) ? values[key] : undefined;
    },
    async readVersion() {
      assertOpen();
      throw new SecretProviderError(
        'read-only',
        'The environment provider has no writable versions.',
      );
    },
    async prepare() {
      assertOpen();
      throw new SecretProviderError('read-only', 'The environment provider is read-only.');
    },
    async getOperation() {
      assertOpen();
      return undefined;
    },
    async listOperations() {
      assertOpen();
      return [];
    },
    async transitionOperation() {
      assertOpen();
      throw new SecretProviderError('read-only', 'The environment provider is read-only.');
    },
    async reclaim() {
      assertOpen();
      throw new SecretProviderError('read-only', 'The environment provider is read-only.');
    },
  };
}
