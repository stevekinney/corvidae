import {
  createR2ObjectOperations,
  ObjectStoreError,
  type ObjectStoreOperations,
} from '@lostgradient/object-store';

import type { Bungalow, OpenBindingBungalowOptions } from './bungalow.ts';
import {
  assertConfigurationWrite,
  type ConfigurationSnapshot,
  type ConfigurationWriteResult,
} from './configuration.ts';
import { injectedDeploymentSecrets, type DeploymentSecrets } from './deployment-secrets.ts';
import { createEnvironmentSecretProvider } from './environment-secret-provider.ts';
import { BungalowFilesystemError, BungalowInputError, BungalowStateError } from './errors.ts';
import { secretVariable, validateBindingDescriptor } from './remote-configuration.ts';
import {
  bindWorkspaceId,
  loadDeploymentId,
  readConfigurationObject,
  readObject,
  reconcileConfiguration,
  requireDatabaseWorkspaceClaim,
} from './remote.ts';
import { assertBungalowName, assertDirectoryName, assertSecretKey } from './validation.ts';

function storeFailure(operation: string, error: unknown): BungalowFilesystemError {
  const cause =
    error instanceof ObjectStoreError && error.status !== undefined
      ? { status: error.status }
      : { code: error instanceof ObjectStoreError ? error.code : 'unknown' };
  return new BungalowFilesystemError(`Could not ${operation}.`, { cause });
}

async function bindingConfiguration(
  client: ObjectStoreOperations,
  key: string,
): Promise<ConfigurationSnapshot> {
  return readConfigurationObject(client, key);
}

/** Open a Worker home using the R2 binding directly, without a process environment or S3 signer. */
export async function openBindingBungalow(options: OpenBindingBungalowOptions): Promise<Bungalow> {
  assertBungalowName(options.name);
  const descriptor = validateBindingDescriptor(options.descriptor);
  const claim = requireDatabaseWorkspaceClaim(options.databaseWorkspaceClaim);
  const name = options.name;
  const writableConfiguration = options.writableConfiguration === true;
  const client = createR2ObjectOperations(descriptor.bucket);
  const deploymentKey = `${descriptor.prefix}deployment-id`;
  const workspaceKey = `${descriptor.prefix}workspace-id`;
  const configurationKey = `${descriptor.prefix}configuration.json`;
  const existingDeployment = await readObject(client, deploymentKey, 'read deployment ID');
  const existingWorkspace = await readObject(client, workspaceKey, 'read workspace identity');
  if (existingDeployment === undefined && existingWorkspace !== undefined) {
    const raced = await readObject(client, deploymentKey, 'read deployment ID');
    if (raced === undefined) {
      throw new BungalowStateError(
        'The workspace identity exists without its persisted deployment identity.',
      );
    }
  }
  if (existingDeployment === undefined && existingWorkspace === undefined) {
    const entries = await client.list(descriptor.prefix).catch((error: unknown) => {
      throw storeFailure('read workspace identity', error);
    });
    const raced = await readObject(client, deploymentKey, 'read deployment ID');
    if (raced === undefined) {
      if (entries.objects.length > 0) {
        throw new BungalowStateError(
          'Existing remote state has no persisted deployment identity. Restore it from a backup.',
        );
      }
      try {
        await claim(descriptor.database, `r2://${descriptor.prefix}`, undefined);
      } catch (error) {
        if ((await readObject(client, deploymentKey, 'read deployment ID')) === undefined)
          throw error;
      }
    }
  }
  const deploymentId = await loadDeploymentId(client, deploymentKey);
  const expectedWorkspaceId = (options.workspaceId ?? deploymentId).trim();
  if (expectedWorkspaceId !== deploymentId) {
    throw new BungalowStateError('The configured workspace identity does not match deployment-id.');
  }
  if (existingWorkspace !== undefined && existingWorkspace.trim() !== expectedWorkspaceId) {
    throw new BungalowStateError('The backing store belongs to a different workspace.');
  }
  await claim(descriptor.database, `r2://${descriptor.prefix}`, expectedWorkspaceId);
  const workspaceId = await bindWorkspaceId(
    client,
    workspaceKey,
    deploymentId,
    options.workspaceId,
  );
  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new BungalowStateError('This Bungalow is closed.');
  };
  const close = (): void => {
    closed = true;
  };
  const variablePrefix = `${name.toUpperCase().replaceAll('-', '_')}_SECRET_`;
  const secretProvider =
    options.secretProvider?.(workspaceId) ??
    createEnvironmentSecretProvider({
      workspaceId,
      values: Object.fromEntries(
        [...descriptor.secrets]
          .filter(([key]) => key.startsWith(variablePrefix))
          .map(([key, value]) => [
            key.slice(variablePrefix.length).toLowerCase().replaceAll('_', '-'),
            value,
          ]),
      ),
      assertOpen,
    });
  if (secretProvider.workspaceId !== workspaceId) {
    throw new BungalowInputError('The secret provider belongs to a different workspace.');
  }
  const deploymentSecrets: DeploymentSecrets =
    options.deploymentSecrets === undefined
      ? {
          writable: false,
          location(key) {
            assertOpen();
            return secretVariable(name, key);
          },
          async write(key) {
            assertOpen();
            assertSecretKey(key);
            throw new BungalowStateError('Deployment secrets are read-only environment inputs.');
          },
          async read(key) {
            assertOpen();
            return descriptor.secrets.get(secretVariable(name, key));
          },
        }
      : injectedDeploymentSecrets(options.deploymentSecrets, { workspaceId, assertOpen });
  return {
    name,
    mode: 'remote',
    capabilities: { sharedBetweenInstances: true, personalMachine: false },
    database: descriptor.database,
    configurationLocation: `r2://${configurationKey}`,
    logs: undefined,
    deploymentId,
    workspaceId,
    objectStore() {
      assertOpen();
      return client;
    },
    content(contentName) {
      assertOpen();
      assertDirectoryName(contentName);
      return { kind: 'object-store', prefix: `${descriptor.prefix}${contentName}/` };
    },
    configurationWriteCapability: writableConfiguration ? 'writable' : 'read-only',
    readConfiguration() {
      assertOpen();
      return bindingConfiguration(client, configurationKey);
    },
    async writeConfiguration(text, condition): Promise<ConfigurationWriteResult> {
      assertOpen();
      assertConfigurationWrite(text, condition);
      if (!writableConfiguration) return { outcome: 'read-only' };
      try {
        const result = await client.put(
          configurationKey,
          new TextEncoder().encode(text),
          condition.expectedRevision === null
            ? { kind: 'absent' }
            : { kind: 'etag', etag: condition.expectedRevision },
        );
        return result.outcome === 'written' ? { outcome: 'committed' } : { outcome: 'conflict' };
      } catch (error) {
        if (error instanceof ObjectStoreError && error.status === 501)
          return { outcome: 'unsupported' };
        if (error instanceof ObjectStoreError && error.status !== undefined && error.status < 500)
          return { outcome: 'unavailable' };
        return reconcileConfiguration(client, configurationKey);
      }
    },
    secretProvider,
    deploymentSecrets,
    close,
    [Symbol.dispose]: close,
  };
}
