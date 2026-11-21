# Backchannel MCP

An application that serves its own operation catalog through `createOperationHandler` can mount its `mcpExposable` operations as MCP tools with `createOperationMcpMount(options)`, on the 2026-07-28 and 2025-11-25 protocol lanes. Each such operation becomes a tool of its own name whose input schema is the operation's, and each call runs through the full catalog pipeline (transport `mcp`, access policy, parsing, `authorize`, output validation) as the principal the handler authenticated. A unary operation answers with its validated output as `structuredContent`; a `subscription` operation answers with the elements recorded after its `fromCursor`, up to `maxEvents` (default 100), and the cursor to resume from, so a client polls it instead of holding a stream; a catalog fault, a refused caller included, is a tool error result. The mount is stateless like `/mcp` and starts nothing the catalog does not.

Supply the host’s name and version in `serverInfo`. Other options include `pathPrefix` (default `/mcp`), `maxBodyBytes`, `maxEvents`, `idleMs` (how long a `subscription` tool waits for the next element, default 250 ms), and two for MCP Apps. `resources` injects `OperationMcpResource` entries (a `ui://` page, say) that the server lists and reads, each optionally narrowed per caller by `authorize`, so a caller it refuses finds the resource neither listed nor readable; the `resources` capability is advertised only when there is at least one. `toolMeta` attaches `_meta` to a tool's listing by operation name, such as the `ui.resourceUri` that links a tool to a page. The mount knows nothing of what a resource holds: the application builds the page and hands it in.

```ts
import { createOperationHandler, defineOperation } from '@lostgradient/backchannel';
import { createOperationMcpMount } from '@lostgradient/backchannel-mcp';
import { z } from 'zod';

const echo = defineOperation({
  name: 'probe.echo',
  mcpExposable: true,
  summary: 'Echo a message',
  destructive: false,
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ message: z.string() }),
  access: { kind: 'public' },
  transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async ({ input }) => ({ message: input.message }),
});

export const handler = createOperationHandler({
  operations: [echo],
  host: {},
  mounts: [
    createOperationMcpMount({
      serverInfo: { name: 'probe', title: 'Probe', version: '1.0.0' },
      resources: [
        {
          uri: 'ui://probe/page',
          name: 'probe-page',
          mimeType: 'text/html;profile=mcp-app',
          text: '<!doctype html><title>probe</title>',
          _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
        },
      ],
      toolMeta: { 'probe.echo': { ui: { resourceUri: 'ui://probe/page' } } },
    }),
  ],
});
```

The mount serves catalog tools and injected resources. [`@lostgradient/bureau`](../bureau/README.md#mcp-adapter-cor-839-cor-910) is the consumer in this repository.
