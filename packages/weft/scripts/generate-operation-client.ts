#!/usr/bin/env bun

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { format, resolveConfig } from 'prettier';

import { compareStrings } from '../src/server/json-schema-utilities.ts';
import type {
  CatalogOperationSnapshot,
  CatalogSnapshot,
} from '../src/server/operation-catalog-snapshot.ts';
import { createCatalogSnapshot } from '../src/server/operation-catalog-snapshot.ts';

import { renderAliasDeclarations, selectAliases } from './operation-client-aliases.ts';
import {
  GENERATED_HEADER,
  operationDomains,
  operationDomainSource,
} from './operation-client-domains.ts';
import { schemaToNode } from './operation-client-schema.ts';

export const OPERATION_CLIENT_DIRECTORY = 'src/client/generated';
export const OPERATION_CLIENT_FILE = 'operation-client.generated.ts';

export async function createOperationClientSources(
  snapshot: CatalogSnapshot,
): Promise<ReadonlyMap<string, string>> {
  const catalogOperations = snapshot.operations
    .filter((operation) => operation.kind === 'unary' && operation.transports.jsonRpcHttp)
    .toSorted((left, right) => compareStrings(left.name, right.name));
  const restOnlyOperations = snapshot.operations
    .filter(isGenericRestClientOperation)
    .toSorted((left, right) => compareStrings(left.name, right.name));
  const clientOperations = [...catalogOperations, ...restOnlyOperations].toSorted((left, right) =>
    compareStrings(left.name, right.name),
  );
  const catalogNames = catalogOperations.map((operation) => `  '${operation.name}',`);
  const clientNames = clientOperations.map((operation) => `  '${operation.name}',`);
  const restBindings = restOnlyOperations.map((operation) => {
    const rest = operation.rest;
    if (rest === undefined) throw new Error(`missing REST binding for ${operation.name}`);
    const clientPath = rest.path.replace(/^\/v1/, '');
    return `  '${operation.name}': ${JSON.stringify({ ...rest, path: clientPath })},`;
  });

  const roots = clientOperations.flatMap((operation) => [
    schemaToNode(operation.inputSchema),
    schemaToNode(operation.outputSchema),
  ]);

  const { aliasNameByKey, nodeByKey } = selectAliases(roots);
  const domains = operationDomains(clientOperations);
  const imports = domains
    .map((domain) => `import type { ${domain.typeName} } from './${domain.fileName}';`)
    .join('\n');
  const types = domains.map((domain) => domain.typeName).join(' & ') || '{}';
  const aliasDeclarations = renderAliasDeclarations(aliasNameByKey, nodeByKey);

  const sources = new Map<string, string>();
  for (const domain of domains)
    sources.set(domain.fileName, operationDomainSource(domain, aliasNameByKey));
  if (aliasDeclarations.length)
    sources.set(
      'shared-operation-types.generated.ts',
      `${GENERATED_HEADER}\n${aliasDeclarations.map((declaration) => `export ${declaration}`).join('\n')}\n`,
    );

  const source = `${GENERATED_HEADER}
${imports}

import {
  createCatalogWeftClient,
  httpJsonRpcTransport,
  type ClientRestOperationBinding,
  type CatalogWeftClient,
  type WeftClientConnection,
} from '../operation-client-runtime.ts';

export const CATALOG_OPERATION_NAMES = [
${catalogNames.join('\n')}
] as const;

export type CatalogOperationName = (typeof CATALOG_OPERATION_NAMES)[number];

export const CLIENT_OPERATION_NAMES = [
${clientNames.join('\n')}
] as const;

export type ClientOperationName = (typeof CLIENT_OPERATION_NAMES)[number];

export const CLIENT_REST_OPERATION_BINDINGS = {
${restBindings.join('\n')}
} as const satisfies Readonly<Record<string, ClientRestOperationBinding>>;

export type ClientOperationTypes = ${types};

export type CatalogOperationTypes = Pick<ClientOperationTypes, CatalogOperationName>;

export type WeftClient = CatalogWeftClient<CatalogOperationTypes>;
export type ClientOperations = CatalogWeftClient<ClientOperationTypes>;

export function createWeftClient(connection: WeftClientConnection = {}): WeftClient {
  return createCatalogWeftClient<CatalogOperationTypes>(
    CATALOG_OPERATION_NAMES,
    httpJsonRpcTransport(connection),
  );
}
`;
  sources.set(OPERATION_CLIENT_FILE, source);
  const formatted = new Map<string, string>();
  for (const [fileName, contents] of sources) {
    const filePath = join(OPERATION_CLIENT_DIRECTORY, fileName);
    const configuration = await resolveConfig(filePath);
    formatted.set(fileName, await format(contents, { ...configuration, filepath: filePath }));
  }
  return formatted;
}

/**
 * Ordinary REST-only unary operations can use the generated JSON request
 * transport. Storage stays on `client.storage`: its octet-stream and NDJSON
 * wire formats require a byte-oriented facade rather than schema-shaped JSON.
 */
function isGenericRestClientOperation(operation: CatalogOperationSnapshot): boolean {
  if (operation.kind !== 'unary') return false;
  if (!operation.transports.http || operation.transports.jsonRpcHttp) return false;
  if (operation.tags.includes('Storage')) return false;
  const rest = operation.rest;
  if (rest === undefined || rest.success.kind === 'streaming') return false;
  return Object.values(rest.inputSources).every(
    (source) => source.kind !== 'body' || source.mediaType !== 'application/octet-stream',
  );
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { 'output-directory': { type: 'string' } },
    strict: true,
  });
  const directory = values['output-directory'] ?? OPERATION_CLIENT_DIRECTORY;
  const sources = await createOperationClientSources(createCatalogSnapshot());
  await mkdir(directory, { recursive: true });
  for (const [fileName, source] of sources) {
    const path = join(directory, fileName);
    await Bun.write(path, source);
    console.log(`wrote ${path}`);
  }
}
