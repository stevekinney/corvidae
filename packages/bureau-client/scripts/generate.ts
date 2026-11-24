import { createOperationClientSources } from '@lostgradient/backchannel/generator';
import { createBureauCatalogSnapshot } from '@lostgradient/bureau';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

export const outputDirectory = join(dirname(fileURLToPath(import.meta.url)), '../src/generated');
export async function createReviewsClientSources(): Promise<ReadonlyMap<string, string>> {
  const snapshot = createBureauCatalogSnapshot();
  const sources = await createOperationClientSources(
    {
      ...snapshot,
      operations: snapshot.operations.filter((operation) =>
        operation.name.startsWith('bureau.reviews.'),
      ),
    },
    {
      packageName: '@lostgradient/bureau-client/reviews',
      serverName: 'Reviews',
      factoryName: 'createReviewsClient',
      outputDirectory,
      portableEntries: true,
      svelte: true,
      format: async (contents, filePath) =>
        format(contents, { ...(await resolveConfig(filePath)), filepath: filePath }),
    },
  );
  const output = new Map<string, string>();
  for (const [name, source] of sources) {
    const complete =
      name === 'operation-client.svelte.ts'
        ? source
            .replace('  createCommand,\n', '')
            .replace(
              "export { getCatalogHost as getReviewsHost } from '@lostgradient/backchannel-svelte';",
              "export { getReviewsHost } from '../reviews/context.ts';",
            )
            .replace(
              "export { default as ReviewsProvider } from '@lostgradient/backchannel-svelte/provider';",
              "export { default as ReviewsProvider } from '../reviews/ReviewsProvider.svelte';",
            )
            .replace(
              /export function useBureauReviewsResolve\(host: CatalogHost\) \{[\s\S]*?\n\}\n/u,
              "export { useApprovalDecision } from '../reviews/tool-approval-actions.svelte.ts';\n",
            )
        : name === 'portable-operation-client.generated.ts'
          ? `${source}\nexport type { ReviewsOperationTypes } from './reviews-operations.generated.ts';\n`
          : source;
    if (
      name === 'operation-client.svelte.ts' &&
      (!complete.includes('export { useApprovalDecision }') ||
        !complete.includes('export { getReviewsHost }') ||
        !complete.includes('../reviews/ReviewsProvider.svelte') ||
        complete.includes('useBureauReviewsResolve'))
    )
      throw new Error('Reviews bindings were not replaced');
    output.set(name, complete);
  }
  return output;
}

if (import.meta.main) {
  await mkdir(outputDirectory, { recursive: true });
  for (const [name, source] of await createReviewsClientSources())
    await Bun.write(join(outputDirectory, name), source);
}
