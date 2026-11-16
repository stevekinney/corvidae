/**
 * Test-only builder for the wire goldens: Weft's generated OpenAPI, OpenRPC and AsyncAPI
 * documents and its catalog snapshot, built from the live registry and REST bindings.
 */

import { join } from 'node:path';

import { generateAsyncApiDocument } from './asyncapi.ts';
import {
  formatGoldenJson,
  withGoldenVersion,
  writeGoldenDirectory,
} from './golden-files.test-support.ts';
import { generateOpenApiDocument } from './openapi.ts';
import { generateOpenRpcDocument } from './openrpc.ts';
import { createCatalogSnapshot } from './operation-catalog-snapshot.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';

export const WIRE_GOLDEN_DIRECTORY = join(import.meta.dir, '__fixtures__', 'wire-golden');

/** The golden files, keyed by file name. */
export function buildWireGolden(): Record<string, string> {
  const registry = createLiveOperationRegistry();
  return {
    'openapi.json': formatGoldenJson(withGoldenVersion(generateOpenApiDocument())),
    'openrpc.json': formatGoldenJson(
      withGoldenVersion(generateOpenRpcDocument({ registry, transports: ['http', 'websocket'] })),
    ),
    'asyncapi.json': formatGoldenJson(withGoldenVersion(generateAsyncApiDocument({ registry }))),
    'catalog-snapshot.json': formatGoldenJson(createCatalogSnapshot()),
  };
}

/** Rewrite a directory to hold exactly the wire goldens. */
export async function writeWireGolden(directory: string): Promise<void> {
  await writeGoldenDirectory(directory, buildWireGolden());
}
