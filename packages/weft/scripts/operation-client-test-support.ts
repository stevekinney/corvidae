import { z } from 'zod';
import { createOperationClientSources } from './generate-operation-client.ts';

import { defineOperation } from '@lostgradient/backchannel';
import type { AccessPolicy } from '@lostgradient/backchannel/internals';
import { createCatalogSnapshot } from '../src/server/weft-catalog-snapshot.ts';

export async function generatedSourcesText(
  snapshot: ReturnType<typeof createCatalogSnapshot>,
): Promise<string> {
  const sources = await createOperationClientSources(snapshot);
  return [...sources.values()].join('\n');
}

export function snapshotTestOperation(name: string, access: AccessPolicy) {
  return defineOperation({
    name,
    mcpExposable: false,
    summary: 'Snapshot access test operation',
    destructive: false,
    inputSchema: z.object({}),
    outputSchema: z.null(),
    access,
    transports: {
      http: true,
      jsonRpcHttp: true,
      jsonRpcStdio: true,
      jsonRpcWebSocket: true,
    },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    invoke: async () => null,
  });
}

export function snapshotOperation(name: string) {
  const operation = createCatalogSnapshot().operations.find((candidate) => candidate.name === name);
  if (operation === undefined) {
    throw new Error(`Missing operation snapshot ${name}`);
  }
  return operation;
}
