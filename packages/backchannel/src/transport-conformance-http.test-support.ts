import {
  httpJsonRpcTransport,
  sseSubscriptionTransport,
  type CatalogFetch,
} from './client/index.ts';
import { createOperationHandler } from './index.ts';
import type { createTransportConformanceFixture } from './transport-conformance.test-support.ts';

export function connectHttp({
  host,
  operations,
}: ReturnType<typeof createTransportConformanceFixture>) {
  const handler = createOperationHandler({ operations, host });
  const fetch: CatalogFetch = (input, init) => handler(new Request(input, init));
  const connection = { baseUrl: 'https://probe.test', fetch };
  return {
    call: httpJsonRpcTransport(connection),
    subscribe: sseSubscriptionTransport(connection),
  };
}
