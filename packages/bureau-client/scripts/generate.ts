import { createOperationClientSources } from '@lostgradient/backchannel/generator';
import { createBureauCatalogSnapshot } from '@lostgradient/bureau';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

function openingSchema(source: Record<string, unknown>): Record<string, unknown> {
  const schema = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
  function relax(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) relax(item);
      return;
    }
    const object = node as Record<string, unknown>;
    const properties = object['properties'] as Record<string, unknown> | undefined;
    const kind = properties?.['kind'] as Record<string, unknown> | undefined;
    if (kind?.['const'] === 'tool-approval' && Array.isArray(object['required']))
      object['required'] = object['required'].filter((key) => key !== 'round');
    for (const value of Object.values(object)) relax(value);
  }
  relax(schema);
  schema['required'] = ['reviews'];
  return schema;
}

function assertSupportedSchema(schema: Record<string, unknown>): void {
  const supported = new Set([
    'type',
    'const',
    'enum',
    'oneOf',
    'anyOf',
    'properties',
    'required',
    'additionalProperties',
    'propertyNames',
    'items',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'minLength',
  ]);
  for (const [key, value] of Object.entries(schema)) {
    if (!supported.has(key)) throw new Error(`Unsupported Reviews schema keyword: ${key}`);
    if (
      key === 'type' &&
      !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(value))
    )
      throw new Error(`Unsupported Reviews schema type: ${String(value)}`);
    if (key === 'properties' && value && typeof value === 'object') {
      for (const child of Object.values(value))
        assertSupportedSchema(child as Record<string, unknown>);
    } else if ((key === 'oneOf' || key === 'anyOf') && Array.isArray(value)) {
      for (const child of value) assertSupportedSchema(child as Record<string, unknown>);
    } else if (
      (key === 'items' || key === 'propertyNames' || key === 'additionalProperties') &&
      value &&
      typeof value === 'object'
    ) {
      assertSupportedSchema(value as Record<string, unknown>);
    }
  }
}

export const outputDirectory = join(dirname(fileURLToPath(import.meta.url)), '../src/generated');
export async function createReviewsClientSources(): Promise<ReadonlyMap<string, string>> {
  const snapshot = createBureauCatalogSnapshot();
  const schemas = Object.fromEntries(
    snapshot.operations
      .filter((operation) => operation.name.startsWith('bureau.reviews.'))
      .map((operation) => [operation.name, operation.outputSchema]),
  );
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
  const operationTypes = sources.get('reviews-operations.generated.ts');
  if (!operationTypes) throw new Error('Reviews operation types were not generated');
  const included = new Set([
    'operation-client.svelte.ts',
    'portable-operation-client.generated.ts',
    'reviews-operations.generated.ts',
    'shared-operation-types.generated.ts',
  ]);
  for (const [name, source] of sources) {
    if (!included.has(name)) continue;
    const complete =
      name === 'operation-client.svelte.ts'
        ? source
            .replace('  createCommand,\n', '')
            .replace(
              "import type { ClientOperationTypes } from './operation-client.generated.ts';",
              "import type { ReviewsOperationTypes as ClientOperationTypes } from './reviews-operations.generated.ts';",
            )
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
          : name === 'shared-operation-types.generated.ts'
            ? source.replace(/export type (Shared\w+)/gu, (declaration, typeName: string) =>
                operationTypes.includes(typeName) ? declaration : `type ${typeName}`,
              )
            : source;
    if (
      name === 'operation-client.svelte.ts' &&
      (!complete.includes('export { useApprovalDecision }') ||
        !complete.includes('export { getReviewsHost }') ||
        !complete.includes('../reviews/ReviewsProvider.svelte') ||
        complete.includes('./operation-client.generated.ts') ||
        complete.includes('useBureauReviewsResolve'))
    )
      throw new Error('Reviews bindings were not replaced');
    const filePath = join(outputDirectory, name);
    output.set(
      name,
      await format(complete, { ...(await resolveConfig(filePath)), filepath: filePath }),
    );
  }
  const portable = output.get('portable-operation-client.generated.ts');
  if (!portable) throw new Error('Portable Reviews client was not generated');
  if (
    !portable.includes(
      'return createCatalogClient<CatalogOperationTypes>(operationNames, transport);',
    )
  )
    throw new Error('Portable Reviews transport binding was not found');
  output.set(
    'portable-operation-client.generated.ts',
    await format(
      portable
        .replace(
          'return createCatalogClient<CatalogOperationTypes>(operationNames, transport);',
          'return createCatalogClient<CatalogOperationTypes>(operationNames, validatedReviewsTransport(transport));',
        )
        .replace(
          'import type { ReviewsOperationTypes }',
          "import { validatedReviewsTransport } from '../reviews/validation.ts';\nimport type { ReviewsOperationTypes }",
        ) +
        "\nexport { parseReviewsOpeningSnapshot, validatedReviewsTransport } from '../reviews/validation.ts';\nexport type { ReviewsOpeningSnapshot } from '../reviews/validation.ts';\n",
      {
        ...(await resolveConfig(join(outputDirectory, 'portable-operation-client.generated.ts'))),
        filepath: join(outputDirectory, 'portable-operation-client.generated.ts'),
      },
    ),
  );
  const list = schemas['bureau.reviews.list'];
  if (!list) throw new Error('Reviews list schema missing');
  for (const schema of Object.values(schemas)) assertSupportedSchema(schema);
  const schemaFile = join(outputDirectory, 'reviews-output-schemas.generated.ts');
  output.set(
    'reviews-output-schemas.generated.ts',
    await format(
      `/* generated by scripts/generate.ts; do not edit by hand */\nexport const reviewsOutputSchemas = ${JSON.stringify({ ...schemas, opening: openingSchema(list) })} as const;\n`,
      { ...(await resolveConfig(schemaFile)), filepath: schemaFile },
    ),
  );
  return output;
}

if (import.meta.main) {
  await mkdir(outputDirectory, { recursive: true });
  for (const [name, source] of await createReviewsClientSources())
    await Bun.write(join(outputDirectory, name), source);
}
