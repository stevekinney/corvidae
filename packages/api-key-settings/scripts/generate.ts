import { createOperationClientSources } from '@lostgradient/backchannel/generator';
import {
  createOperationRegistry,
  snapshotOperationCatalog,
} from '@lostgradient/backchannel/internals';
import { format, resolveConfig } from 'prettier';
import { apiKeyManagementOperations, type ApiKeyManagementHost } from '../src/backchannel.ts';

const sources = await createOperationClientSources(
  snapshotOperationCatalog({
    operations: createOperationRegistry<ApiKeyManagementHost>(apiKeyManagementOperations).list(),
    restBindings: [],
  }),
  {
    packageName: '@lostgradient/api-key-settings',
    serverName: 'ApiKeySettings',
    factoryName: 'createApiKeySettingsClient',
    outputDirectory: 'src/generated',
    subscriptions: 'none',
    svelte: true,
    entries: ['client', 'svelte'],
    typeOnlyClient: true,
    format: async (source, filePath) =>
      format(source, { ...(await resolveConfig(filePath)), filepath: filePath }),
  },
);
for (const [file, source] of sources) {
  const path = new URL(`../src/generated/${file}`, import.meta.url);
  if (process.argv.includes('--check')) {
    if ((await Bun.file(path).text()) !== source)
      throw new Error(`Generated file is stale: ${file}`);
  } else await Bun.write(path, source);
}
