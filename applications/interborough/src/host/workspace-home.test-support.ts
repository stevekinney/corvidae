import {
  createLocalSecretProvider,
  openBungalow,
  parseSecretReference,
} from '@lostgradient/bungalow';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Persist a fresh fixture home's identity before the fixture writes application state. */
export async function initializeWorkspaceHome(home: string): Promise<void> {
  using bungalow = await openBungalow({
    name: 'interborough',
    environment: { INTERBOROUGH_HOME: home },
  });
  bungalow.close();
}

/** Read exactly the version selected by the saved configuration, including its actual file path. */
export async function storedWorkspaceSecret(root: string, key: string) {
  const identity = await readFile(join(root, 'deployment-id'), 'utf8');
  const workspaceId = identity.trim();
  const text = await readFile(join(root, 'configuration.json'), 'utf8');
  const document = JSON.parse(text) as { secretBindings?: Record<string, string> };
  const binding = document.secretBindings?.[key];
  const provider = createLocalSecretProvider({ root, workspaceId });
  if (binding === undefined)
    return { value: await provider.readLegacy(key), path: join(root, 'secrets', key) };
  const reference = parseSecretReference(binding, workspaceId);
  if (reference.key !== key) throw new Error('Wrong stored secret binding');
  return {
    value: await provider.readVersion(reference),
    path: join(root, '.managed-secrets', 'versions', reference.version),
  };
}
