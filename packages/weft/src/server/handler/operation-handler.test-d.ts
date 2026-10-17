import { z } from 'zod';

import { defineOperation } from '../operation-registry.ts';
import { createOperationHandler } from './operation-handler.ts';

type FeedHost = { readonly feeds: ReadonlyMap<string, never> };

const needsFeeds = defineOperation<z.ZodObject<{}>, z.ZodObject<{}>, FeedHost>({
  name: 'probe.feeds',
  mcpExposable: false,
  summary: 'reads host.feeds',
  destructive: false,
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  access: { kind: 'public' },
  transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async ({ host }) => {
    void host.feeds;
    return {};
  },
});

// The host is inferred from `host` alone, so an operation that reads a
// capability the host lacks is a compile error at the call, not a failure when
// the operation runs.
const hostWithFeeds = { feeds: new Map<string, never>(), extra: true };
void createOperationHandler({ operations: [needsFeeds], host: hostWithFeeds });

// @ts-expect-error — the host has no `feeds`, which this operation reads.
void createOperationHandler({ operations: [needsFeeds], host: {} });

// @ts-expect-error — `feeds` has the wrong type for this operation.
void createOperationHandler({ operations: [needsFeeds], host: { feeds: 'not a map' } });
